#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@schuettc/pi-usage"
PACKAGE_JSON="extensions/pi-usage/package.json"
LOCK_JSON="package-lock.json"
PUBLICATION_BRANCH="schuettc-publish"
UPSTREAM_TAG="pi-usage-upstream-base"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SYNC_CLEANUP_REPOSITORY=''
SYNC_CLEANUP_WORKTREE=''
SYNC_CLEANUP_ROOT=''
FIXTURE_CLEANUP_ROOT=''

fail() {
  printf 'upstream-sync: %s\n' "$*" >&2
  return 1
}

resolve_identity_json_conflict() {
  local worktree="$1"
  local path="$2"
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/pi-usage-identity-merge.XXXXXX")"

  if ! git -C "$worktree" show ":1:$path" > "$scratch/base.json" ||
    ! git -C "$worktree" show ":2:$path" > "$scratch/ours.json" ||
    ! git -C "$worktree" show ":3:$path" > "$scratch/theirs.json"; then
    rm -rf "$scratch"
    return 1
  fi

  if ! node - "$path" "$scratch/base.json" "$scratch/ours.json" "$scratch/theirs.json" "$worktree/$path" <<'NODE'
const fs = require("node:fs");
const [file, basePath, oursPath, theirsPath, outputPath] = process.argv.slice(2);
const MISSING = Symbol("missing");
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const equal = (left, right) => {
  if (left === MISSING || right === MISSING) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
};
const object = (value) => value !== MISSING && value !== null && !Array.isArray(value) && typeof value === "object";
const allowedIdentityConflict = (path) => {
  if (file === "extensions/pi-usage/package.json") {
    return path.length === 1 && (path[0] === "name" || path[0] === "version");
  }
  if (file === "package-lock.json") {
    return path.length === 3 && path[0] === "packages" && path[1] === "extensions/pi-usage" &&
      (path[2] === "name" || path[2] === "version");
  }
  return false;
};
const display = (path) => path.length === 0 ? "<root>" : path.join(".");
const merge = (base, ours, theirs, path = []) => {
  if (equal(ours, theirs)) return ours;
  if (equal(base, ours)) return theirs;
  if (equal(base, theirs)) return ours;

  if (object(base) && object(ours) && object(theirs)) {
    const result = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    for (const key of keys) {
      const value = merge(
        Object.hasOwn(base, key) ? base[key] : MISSING,
        Object.hasOwn(ours, key) ? ours[key] : MISSING,
        Object.hasOwn(theirs, key) ? theirs[key] : MISSING,
        [...path, key],
      );
      if (value !== MISSING) result[key] = value;
    }
    return result;
  }

  if (allowedIdentityConflict(path)) return theirs;
  throw new Error(`non-identity JSON conflict at ${file}:${display(path)}`);
};

try {
  const merged = merge(read(basePath), read(oursPath), read(theirsPath));
  fs.writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
  then
    rm -rf "$scratch"
    return 1
  fi

  rm -rf "$scratch"
  git -C "$worktree" add -- "$path"
}

replay_patch_commit() {
  local worktree="$1"
  local commit="$2"

  if git -C "$worktree" -c user.name='pi-usage sync' -c user.email='actions@users.noreply.github.com' cherry-pick "$commit"; then
    return 0
  fi

  local unresolved
  unresolved="$(git -C "$worktree" diff --name-only --diff-filter=U)"
  if [ -z "$unresolved" ]; then
    if git -C "$worktree" rev-parse --verify -q CHERRY_PICK_HEAD >/dev/null &&
      git -C "$worktree" diff --cached --quiet; then
      git -C "$worktree" cherry-pick --skip
      return 0
    fi
    git -C "$worktree" cherry-pick --abort >/dev/null 2>&1 || true
    fail "cherry-pick failed for $commit"
    return 1
  fi

  local path
  while IFS= read -r path; do
    case "$path" in
      "$PACKAGE_JSON"|"$LOCK_JSON")
        if ! resolve_identity_json_conflict "$worktree" "$path"; then
          git -C "$worktree" cherry-pick --abort >/dev/null 2>&1 || true
          fail "non-identity cherry-pick conflict in $path at $commit"
          return 1
        fi
        ;;
      *)
        git -C "$worktree" cherry-pick --abort >/dev/null 2>&1 || true
        fail "non-identity cherry-pick conflict in $path at $commit"
        return 1
        ;;
    esac
  done <<< "$unresolved"

  if ! GIT_EDITOR=true git -C "$worktree" -c user.name='pi-usage sync' -c user.email='actions@users.noreply.github.com' cherry-pick --continue; then
    git -C "$worktree" cherry-pick --abort >/dev/null 2>&1 || true
    fail "could not continue cherry-pick for $commit"
    return 1
  fi
}

lookup_published_versions() {
  local output="$1"
  local errors="$2"

  if [ -n "${PI_USAGE_NPM_VERSION_LOOKUP:-}" ]; then
    if ! "$PI_USAGE_NPM_VERSION_LOOKUP" "$PACKAGE_NAME" > "$output"; then
      fail 'injected npm version lookup failed'
      return 1
    fi
    return 0
  fi

  if npm view "$PACKAGE_NAME" versions --json > "$output" 2> "$errors"; then
    return 0
  fi
  if grep -Eqi 'E404|404 Not Found' "$output" "$errors"; then
    printf '[]\n' > "$output"
    return 0
  fi
  cat "$errors" >&2
  fail 'npm version lookup failed'
}

next_published_suffix() {
  local upstream_version="$1"
  local versions_file="$2"
  node - "$upstream_version" "$versions_file" <<'NODE'
const fs = require("node:fs");
const [base, path] = process.argv.slice(2);
const raw = fs.readFileSync(path, "utf8").trim();
let versions = raw === "" ? [] : JSON.parse(raw);
if (typeof versions === "string") versions = [versions];
if (!Array.isArray(versions)) throw new Error("npm version lookup did not return a version array");
const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`^${escaped}-schuettc\\.(\\d+)$`);
let maximum = 0;
for (const version of versions) {
  const match = typeof version === "string" ? version.match(pattern) : null;
  if (match) maximum = Math.max(maximum, Number(match[1]));
}
console.log(maximum + 1);
NODE
}

rewrite_package_identity() {
  local worktree="$1"
  local version="$2"
  node - "$worktree/$PACKAGE_JSON" "$worktree/$LOCK_JSON" "$PACKAGE_NAME" "$version" <<'NODE'
const fs = require("node:fs");
const [manifestPath, lockPath, packageName, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const workspace = lock.packages?.["extensions/pi-usage"];
if (!workspace) throw new Error("package-lock.json does not contain extensions/pi-usage");

manifest.name = packageName;
manifest.version = version;
workspace.name = packageName;
workspace.version = version;

const expectedLink = `node_modules/${packageName}`;
for (const key of Object.keys(lock.packages)) {
  if (key !== expectedLink && lock.packages[key]?.link === true && lock.packages[key]?.resolved === "extensions/pi-usage") {
    delete lock.packages[key];
  }
}
if (!lock.packages[expectedLink]) {
  lock.packages[expectedLink] = { resolved: "extensions/pi-usage", link: true };
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
NODE
}

run_sync() {
  local repository
  repository="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    fail 'run this script from a Git repository'
    return 1
  }
  cd "$repository"

  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    fail 'worktree is dirty; commit, stash, or remove changes before synchronization'
    return 1
  fi

  git fetch --prune origin "+refs/heads/$PUBLICATION_BRANCH:refs/remotes/origin/$PUBLICATION_BRANCH"
  git fetch --prune upstream '+refs/heads/master:refs/remotes/upstream/master'
  if ! git fetch --force origin "refs/tags/$UPSTREAM_TAG:refs/tags/$UPSTREAM_TAG"; then
    fail "origin is missing the annotated $UPSTREAM_TAG tag"
    return 1
  fi

  if [ "$(git cat-file -t "refs/tags/$UPSTREAM_TAG" 2>/dev/null || true)" != 'tag' ]; then
    fail "$UPSTREAM_TAG must be an annotated tag"
    return 1
  fi

  local base_commit upstream_tip publication_tip base_tag_object
  base_commit="$(git rev-parse "refs/tags/$UPSTREAM_TAG^{commit}")"
  base_tag_object="$(git rev-parse "refs/tags/$UPSTREAM_TAG")"
  upstream_tip="$(git rev-parse refs/remotes/upstream/master)"
  publication_tip="$(git rev-parse "refs/remotes/origin/$PUBLICATION_BRANCH")"

  if ! git merge-base --is-ancestor "$base_commit" "$upstream_tip"; then
    fail "upstream/master does not descend from recorded base $base_commit"
    return 1
  fi

  if [ "$base_commit" = "$upstream_tip" ]; then
    printf 'upstream/master has not moved; nothing to publish\n'
    printf 'SYNC_STATUS=no-op\n'
    return 0
  fi

  if ! git merge-base --is-ancestor "$base_commit" "$publication_tip"; then
    fail "$PUBLICATION_BRANCH does not descend from recorded base $base_commit"
    return 1
  fi

  local merge_commits
  merge_commits="$(git rev-list --min-parents=2 "$base_commit..$publication_tip")"
  if [ -n "$merge_commits" ]; then
    fail "$PUBLICATION_BRANCH patch stack contains merge commits"
    return 1
  fi

  local upstream_version
  upstream_version="$(git show "$upstream_tip:$PACKAGE_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);if(typeof p.version!=='string'||p.version==='')process.exit(1);process.stdout.write(p.version)})")"

  local sync_root sync_worktree commits_file versions_file lookup_errors
  sync_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-usage-sync.XXXXXX")"
  sync_worktree="$sync_root/worktree"
  commits_file="$sync_root/commits"
  versions_file="$sync_root/versions.json"
  lookup_errors="$sync_root/npm-errors.log"
  SYNC_CLEANUP_REPOSITORY="$repository"
  SYNC_CLEANUP_WORKTREE="$sync_worktree"
  SYNC_CLEANUP_ROOT="$sync_root"
  cleanup_sync() {
    if [ -n "${SYNC_CLEANUP_WORKTREE:-}" ]; then
      git -C "$SYNC_CLEANUP_REPOSITORY" worktree remove --force "$SYNC_CLEANUP_WORKTREE" >/dev/null 2>&1 || true
    fi
    if [ -n "${SYNC_CLEANUP_ROOT:-}" ]; then
      rm -rf "$SYNC_CLEANUP_ROOT"
    fi
    SYNC_CLEANUP_REPOSITORY=''
    SYNC_CLEANUP_WORKTREE=''
    SYNC_CLEANUP_ROOT=''
  }
  trap cleanup_sync EXIT INT TERM

  git worktree add --quiet --detach "$sync_worktree" "$upstream_tip"
  while IFS= read -r commit; do
    if [ -z "$commit" ]; then
      continue
    fi
    case "$(git show -s --format='%s' "$commit")" in
      'chore(release):'*) ;;
      *) printf '%s\n' "$commit" >> "$commits_file" ;;
    esac
  done < <(git rev-list --reverse --topo-order "$base_commit..$publication_tip")

  if [ -f "$commits_file" ]; then
    local commit
    while IFS= read -r commit; do
      replay_patch_commit "$sync_worktree" "$commit"
    done < "$commits_file"
  fi

  lookup_published_versions "$versions_file" "$lookup_errors"
  local suffix version
  suffix="$(next_published_suffix "$upstream_version" "$versions_file")"
  version="$upstream_version-schuettc.$suffix"
  rewrite_package_identity "$sync_worktree" "$version"

  (
    cd "$sync_worktree"
    npm ci
    npm run check
  )

  git -C "$sync_worktree" add -- "$PACKAGE_JSON" "$LOCK_JSON"
  if git -C "$sync_worktree" diff --cached --quiet; then
    fail 'package identity rewrite produced no release changes'
    return 1
  fi
  git -C "$sync_worktree" -c user.name='pi-usage sync' -c user.email='actions@users.noreply.github.com' \
    commit --quiet -m "chore(release): $PACKAGE_NAME@$version"

  local result_commit release_tag
  result_commit="$(git -C "$sync_worktree" rev-parse HEAD)"
  release_tag="pi-usage-v$version"

  if [ "${PI_USAGE_SYNC_DRY_RUN:-0}" = '1' ]; then
    printf 'DRY_RUN: git push --force-with-lease origin HEAD:%s\n' "$PUBLICATION_BRANCH"
    printf 'DRY_RUN: git tag and push %s\n' "$release_tag"
    printf 'DRY_RUN: move and push %s to %s\n' "$UPSTREAM_TAG" "$upstream_tip"
  else
    git -C "$sync_worktree" push \
      --force-with-lease="refs/heads/$PUBLICATION_BRANCH:$publication_tip" \
      origin "HEAD:refs/heads/$PUBLICATION_BRANCH"
    git -C "$sync_worktree" -c user.name='pi-usage sync' -c user.email='actions@users.noreply.github.com' \
      tag -a "$release_tag" -m "$PACKAGE_NAME@$version"
    git -C "$sync_worktree" push origin "refs/tags/$release_tag"
    git -C "$sync_worktree" -c user.name='pi-usage sync' -c user.email='actions@users.noreply.github.com' \
      tag -f -a "$UPSTREAM_TAG" "$upstream_tip" -m "Upstream base for $PACKAGE_NAME@$version"
    git -C "$sync_worktree" push \
      --force-with-lease="refs/tags/$UPSTREAM_TAG:$base_tag_object" \
      origin "refs/tags/$UPSTREAM_TAG"
  fi

  cleanup_sync
  trap - EXIT INT TERM
  printf 'SYNC_STATUS=changed\n'
  printf 'SYNC_VERSION=%s\n' "$version"
  printf 'SYNC_RESULT_COMMIT=%s\n' "$result_commit"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [ "$expected" != "$actual" ]; then
    printf 'fixture assertion failed: %s (expected %q, got %q)\n' "$message" "$expected" "$actual" >&2
    return 1
  fi
}

assert_contains() {
  local path="$1"
  local text="$2"
  local message="$3"
  if ! grep -Fq -- "$text" "$path"; then
    printf 'fixture assertion failed: %s (missing %q in %s)\n' "$message" "$text" "$path" >&2
    return 1
  fi
}

fixture_git() {
  local repository="$1"
  shift
  git -C "$repository" -c user.name='Fixture User' -c user.email='fixture@example.test' "$@"
}

write_fixture_manifest() {
  local repository="$1"
  local name="$2"
  local version="$3"

  mkdir -p "$repository/extensions/pi-usage"
  cat > "$repository/package.json" <<'JSON'
{
  "name": "fixture-root",
  "version": "1.0.0",
  "private": true,
  "workspaces": ["extensions/*"],
  "scripts": {
    "check": "node -e \"console.log('fixture full check passed')\""
  }
}
JSON
  cat > "$repository/extensions/pi-usage/package.json" <<JSON
{
  "name": "$name",
  "version": "$version",
  "private": false
}
JSON
  (
    cd "$repository"
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
  )
}

fixture_run_sync() {
  local repository="$1"
  local lookup="$2"
  local lookup_log="$3"
  local output="$4"
  (
    cd "$repository"
    PI_USAGE_NPM_VERSION_LOOKUP="$lookup" \
      PI_USAGE_LOOKUP_LOG="$lookup_log" \
      bash "$SCRIPT_PATH" --dry-run
  ) >"$output" 2>&1
}

run_fixture_tests() {
  local fixture_root
  fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-usage-sync-fixture.XXXXXX")"
  FIXTURE_CLEANUP_ROOT="$fixture_root"
  cleanup_fixture() {
    if [ -n "${FIXTURE_CLEANUP_ROOT:-}" ]; then
      rm -rf "$FIXTURE_CLEANUP_ROOT"
      FIXTURE_CLEANUP_ROOT=''
    fi
  }
  trap cleanup_fixture EXIT INT TERM

  local upstream_bare="$fixture_root/upstream.git"
  local origin_bare="$fixture_root/origin.git"
  local seed="$fixture_root/seed"
  local fork="$fixture_root/fork"
  local runner="$fixture_root/runner"
  local lookup="$fixture_root/npm-version-lookup.sh"
  local lookup_log="$fixture_root/npm-version-lookup.log"
  local output="$fixture_root/sync.out"

  git init --bare -q "$upstream_bare"
  git init --bare -q "$origin_bare"
  git init -q -b master "$seed"
  write_fixture_manifest "$seed" '@sreetej510/pi-usage' '1.0.0'
  printf 'base\n' > "$seed/shared.txt"
  fixture_git "$seed" add .
  fixture_git "$seed" commit -q -m 'upstream base'
  local base_commit
  base_commit="$(git -C "$seed" rev-parse HEAD)"
  fixture_git "$seed" remote add upstream "$upstream_bare"
  fixture_git "$seed" remote add origin "$origin_bare"
  fixture_git "$seed" push -q upstream master
  fixture_git "$seed" push -q origin master

  git clone -q -b master "$origin_bare" "$fork"
  fixture_git "$fork" switch -q -c "$PUBLICATION_BRANCH"
  write_fixture_manifest "$fork" "$PACKAGE_NAME" '1.0.0-schuettc.3'
  printf 'fork feature\n' > "$fork/shared.txt"
  printf 'retained\n' > "$fork/feature-only.txt"
  fixture_git "$fork" add .
  fixture_git "$fork" commit -q -m 'feat: retain fork behavior'

  write_fixture_manifest "$fork" "$PACKAGE_NAME" '1.0.0-schuettc.99'
  printf 'must be dropped\n' > "$fork/release-only.txt"
  fixture_git "$fork" add .
  fixture_git "$fork" commit -q -m 'chore(release): @schuettc/pi-usage@1.0.0-schuettc.99'
  local prior_release
  prior_release="$(git -C "$fork" rev-parse HEAD)"
  fixture_git "$fork" push -q origin "$PUBLICATION_BRANCH"
  fixture_git "$fork" tag -a "$UPSTREAM_TAG" "$base_commit" -m 'fixture upstream base'
  fixture_git "$fork" push -q origin "refs/tags/$UPSTREAM_TAG"

  git clone -q -b master "$origin_bare" "$runner"
  fixture_git "$runner" remote add upstream "$upstream_bare"

  cat > "$lookup" <<'LOOKUP'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "$PI_USAGE_LOOKUP_LOG"
printf '%s\n' '["1.0.0-schuettc.500", "1.1.0-schuettc.2", "1.1.0-schuettc.7"]'
LOOKUP
  chmod +x "$lookup"
  printf '[]\n' > "$fixture_root/empty-versions.json"
  assert_eq '1' "$(next_published_suffix '2.0.0' "$fixture_root/empty-versions.json")" 'an unpublished upstream version starts at suffix 1'

  fixture_run_sync "$runner" "$lookup" "$lookup_log" "$output"
  assert_contains "$output" 'SYNC_STATUS=no-op' 'an unchanged upstream is a successful no-op'
  if [ -e "$lookup_log" ]; then
    fail 'fixture assertion failed: no-op queried npm versions'
  fi
  assert_eq "$prior_release" "$(git ls-remote "$origin_bare" "refs/heads/$PUBLICATION_BRANCH" | awk '{print $1}')" 'no-op did not push the publication branch'
  assert_eq "$base_commit" "$(git ls-remote "$origin_bare" "refs/tags/$UPSTREAM_TAG^{}" | awk '{print $1}')" 'no-op did not move the upstream-base tag'

  write_fixture_manifest "$seed" '@sreetej510/pi-usage' '1.1.0'
  printf 'new upstream content\n' > "$seed/upstream-only.txt"
  fixture_git "$seed" add .
  fixture_git "$seed" commit -q -m 'upstream: release 1.1.0'
  local upstream_tip
  upstream_tip="$(git -C "$seed" rev-parse HEAD)"
  fixture_git "$seed" push -q upstream master

  : > "$lookup_log"
  if ! fixture_run_sync "$runner" "$lookup" "$lookup_log" "$output"; then
    cat "$output" >&2
    return 1
  fi
  assert_contains "$output" 'SYNC_STATUS=changed' 'moving upstream rebuilds the publication branch'
  assert_contains "$output" 'SYNC_VERSION=1.1.0-schuettc.8' 'suffix follows the maximum published suffix for the upstream version'
  assert_contains "$output" 'fixture full check passed' 'the full check ran'
  assert_eq "$PACKAGE_NAME" "$(cat "$lookup_log")" 'the npm lookup is injectable and package-scoped'

  local result_commit
  result_commit="$(sed -n 's/^SYNC_RESULT_COMMIT=//p' "$output" | tail -1)"
  if [ -z "$result_commit" ]; then
    fail 'fixture assertion failed: sync did not report its reconstructed commit'
  fi
  fixture_git "$runner" merge-base --is-ancestor "$upstream_tip" "$result_commit"
  assert_contains <(fixture_git "$runner" show "$result_commit:feature-only.txt") 'retained' 'feature content survived reconstruction'
  if fixture_git "$runner" cat-file -e "$result_commit:release-only.txt" 2>/dev/null; then
    fail 'fixture assertion failed: a prior release-only change survived reconstruction'
  fi
  assert_eq "$PACKAGE_NAME" "$(fixture_git "$runner" show "$result_commit:$PACKAGE_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).name))")" 'package scope remains owned by schuettc'
  assert_eq '1.1.0-schuettc.8' "$(fixture_git "$runner" show "$result_commit:$PACKAGE_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))")" 'working-tree suffix is ignored'
  assert_eq "$PACKAGE_NAME" "$(fixture_git "$runner" show "$result_commit:$LOCK_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).packages['extensions/pi-usage'].name))")" 'lockfile package scope is rewritten'
  assert_eq '1.1.0-schuettc.8' "$(fixture_git "$runner" show "$result_commit:$LOCK_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).packages['extensions/pi-usage'].version))")" 'lockfile receives the computed version'
  assert_contains <(fixture_git "$runner" log --format='%s' "$upstream_tip..$result_commit") 'feat: retain fork behavior' 'feature commit was replayed'
  if fixture_git "$runner" log --format='%s' "$upstream_tip..$result_commit" | grep -Fq '1.0.0-schuettc.99'; then
    fail 'fixture assertion failed: prior release commit was replayed'
  fi
  assert_eq "$prior_release" "$(git ls-remote "$origin_bare" "refs/heads/$PUBLICATION_BRANCH" | awk '{print $1}')" 'dry-run did not push the publication branch'
  assert_eq "$base_commit" "$(git ls-remote "$origin_bare" "refs/tags/$UPSTREAM_TAG^{}" | awk '{print $1}')" 'dry-run did not move the upstream-base tag'
  if fixture_git "$runner" show-ref --verify --quiet 'refs/tags/pi-usage-v1.1.0-schuettc.8'; then
    fail 'fixture assertion failed: dry-run created a release tag'
  fi

  printf 'dirty\n' > "$runner/dirty.txt"
  if fixture_run_sync "$runner" "$lookup" "$lookup_log" "$output"; then
    fail 'fixture assertion failed: dirty worktree was accepted'
  fi
  assert_contains "$output" 'worktree is dirty' 'dirty worktree is refused'
  rm "$runner/dirty.txt"

  printf 'upstream conflict\n' > "$seed/shared.txt"
  fixture_git "$seed" add shared.txt
  fixture_git "$seed" commit -q -m 'upstream: conflict with fork patch'
  fixture_git "$seed" push -q upstream master
  if fixture_run_sync "$runner" "$lookup" "$lookup_log" "$output"; then
    fail 'fixture assertion failed: non-identity cherry-pick conflict was accepted'
  fi
  assert_contains "$output" 'non-identity cherry-pick conflict' 'non-identity conflicts fail closed'

  fixture_git "$seed" switch -q --orphan rewritten-master
  write_fixture_manifest "$seed" '@sreetej510/pi-usage' '9.0.0'
  fixture_git "$seed" add .
  fixture_git "$seed" commit -q -m 'rewritten upstream history'
  fixture_git "$seed" push -q --force upstream HEAD:master
  if fixture_run_sync "$runner" "$lookup" "$lookup_log" "$output"; then
    fail 'fixture assertion failed: non-fast-forward upstream history was accepted'
  fi
  assert_contains "$output" 'does not descend from recorded base' 'rewritten upstream history is refused'

  cleanup_fixture
  trap - EXIT INT TERM
  printf 'upstream-sync fixture tests passed\n'
}

case "${1:-}" in
  --fixture-test)
    if [ "$#" -ne 1 ]; then
      fail '--fixture-test does not accept additional arguments'
      exit 2
    fi
    run_fixture_tests
    ;;
  --dry-run)
    if [ "$#" -ne 1 ]; then
      fail '--dry-run does not accept additional arguments'
      exit 2
    fi
    PI_USAGE_SYNC_DRY_RUN=1 run_sync
    ;;
  '')
    run_sync
    ;;
  *)
    fail "unknown argument: $1"
    exit 2
    ;;
esac
