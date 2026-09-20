// GENERATED FILE - DO NOT EDIT
//
// This part's handler map, derived from each contract's own declared filePath.
// Hand-written registration -- a register(broker) listing every contract one at a
// time -- is what this replaces. See docs/CONTRACT_DRIVEN_PLACEMENT.md.
import type { ContractHandlerMap } from '@flybyme/mesh';

// Side-effect imports: evaluating a contract module is what registers its contracts
// with globalContractRegistry, which is where loadDomain reads them from.
import './contracts/artifact.contract.js';
import './contracts/composition.contract.js';
import './contracts/corePart.contract.js';
import './contracts/part.contract.js';
import './contracts/release.contract.js';
import './contracts/repo.contract.js';

/** Every domain whose contracts this part implements, primary first. */
export const domains = ['serve.part', 'serve.repo', 'serve.release', 'serve.artifact', 'serve.corePart', 'serve.composition'] as const;

/** Tool key -> the handler its contract points at. CRUD actions need none. */
export const handlers: ContractHandlerMap = {
};
