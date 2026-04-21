/**
 * Default entry point — Node.js.
 *
 * Re-exports everything from core (platform-agnostic) plus the Node-specific
 * analyzeAudio() function for backward compatibility.
 *
 * For browser usage, import from '@aidios/analyzer/core' and
 * '@aidios/analyzer/browser' instead.
 */

export * from './core.ts'
export { analyzeAudio, type AnalysisOptions } from './node/index.ts'
