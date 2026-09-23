import { createRequire } from "node:module";

type MutationLockRequireFactory = typeof createRequire;

let mutationLockRequireFactory: MutationLockRequireFactory = createRequire;

/** Supplies the factory invoked by the guarded, lazy mutation-lock resolver. */
export function getMutationLockRequireFactory(): MutationLockRequireFactory {
  return mutationLockRequireFactory;
}

/** Injects require setup failures without patching Node's builtin module binding. */
export function configureMutationLockRequireFactoryForTests(factory: MutationLockRequireFactory = createRequire): void {
  mutationLockRequireFactory = factory;
}
