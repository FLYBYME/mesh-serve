/**
 * The `telem` module: centralized telemetry ingest, per-site configuration,
 * dual-sink storage (NDJSON file + Mongo collection), and request logging.
 */

import { TelemService } from './telem.service.js';

export * from './schema/telem.js';
export * from './contracts/telem.contract.js';
export * from './methods/config.js';
export * from './methods/rate-limit.js';
export * from './sinks/sink.js';
export * from './sinks/file-sink.js';
export * from './sinks/collection-sink.js';
export * from './sinks/composite-sink.js';
export * from './sinks/default.js';
export { TelemService };
export default TelemService;
