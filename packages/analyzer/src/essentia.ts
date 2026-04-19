/**
 * Typed wrapper around essentia.js WASM.
 *
 * essentia.js loads synchronously as a CJS UMD module. We use createRequire
 * so this ESM file can require() it.
 *
 * CRITICAL: All VectorFloat objects returned by Essentia algorithms must be
 * .delete()'d after use. The WASM heap is ~256MB. A full 486s track at
 * 22050Hz = 42MB in WASM. Never keep two large vectors alive simultaneously.
 */

import { createRequire } from 'node:module'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmVector = any

export interface RhythmResult {
  bpm: number
  beatTimes: number[]     // beat positions in seconds
  confidence: number
  bpmEstimates: number[]
}

export interface KeyResult {
  keyInt: number      // 0–11 (C through B)
  modeInt: number     // 1=major, 0=minor
  strength: number    // 0.0–1.0
}

export interface SpectralFrame {
  timbre: number[]   // 12 MFCC coefficients (first 12 of 13)
  pitches: number[]  // 12 chroma values, max normalized to 1.0
}

const KEY_MAP: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3,
  E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8,
  Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
}

let instance: EssentiaWrapper | null = null

export function getEssentia(): EssentiaWrapper {
  if (!instance) instance = new EssentiaWrapper()
  return instance
}

export class EssentiaWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private e: any

  constructor() {
    const require = createRequire(import.meta.url)
    const { EssentiaWASM, Essentia } = require('essentia.js')
    // EssentiaWASM is already loaded — do NOT call it as a function
    this.e = new Essentia(EssentiaWASM)
  }

  get version(): string { return this.e.version }

  toVec(arr: Float32Array): WasmVector {
    return this.e.arrayToVector(arr)
  }

  fromVec(vec: WasmVector): Float32Array {
    if (vec.size() === 0) return new Float32Array(0)
    return this.e.vectorToArray(vec) as Float32Array
  }

  /**
   * Extract beats and BPM using RhythmExtractor2013.
   * Operates on the full audio vector. Call vec.delete() after.
   */
  rhythmExtractor(vec: WasmVector): RhythmResult {
    // RhythmExtractor2013(signal, maxTempo=208, method='multifeature', minTempo=40)
    // Returns: { bpm, ticks, confidence, estimates, bpmIntervals }
    const r = this.e.RhythmExtractor2013(vec, 208, 'multifeature', 40)
    const beatTimes = Array.from(this.fromVec(r.ticks)) as number[]
    const bpmEstimates = r.estimates ? Array.from(this.fromVec(r.estimates)) as number[] : []
    r.ticks.delete()
    r.estimates?.delete()
    r.bpmIntervals?.delete()
    return { bpm: r.bpm, beatTimes, confidence: r.confidence, bpmEstimates }
  }

  /**
   * Extract key and mode using KeyExtractor.
   * Operates on the full audio vector. Call vec.delete() after.
   */
  keyExtractor(vec: WasmVector, sampleRate: number): KeyResult {
    // KeyExtractor(signal, averageDetuningCorrection, frameSize, hopSize, hpcpSize,
    //              maxFrequency, maxPeaks, minFrequency, spectralPeaksThreshold,
    //              profileType, sampleRate, tuningFrequency, usePolyphony, windowSize)
    const r = this.e.KeyExtractor(
      vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2,
      'bgate', sampleRate, 0.0001, 440, 'cosine', 'hann'
    )
    const keyInt = KEY_MAP[r.key] ?? 0
    const modeInt = r.scale === 'major' ? 1 : 0
    return { keyInt, modeInt, strength: r.strength }
  }

  /**
   * Detect onset times using SuperFluxExtractor.
   * Process in chunks (max 60s) to avoid WASM heap exhaustion.
   * vec must correspond to at most CHUNK_SECS of audio.
   * Returns onset times IN THE CHUNK (not offset-corrected — caller adds offset).
   */
  superFluxOnsets(vec: WasmVector, sampleRate: number, threshold = 0.05): number[] {
    // SuperFluxExtractor(signal, combine=20, frameSize=2048, hopSize=256,
    //                    ratioThreshold=16, sampleRate, threshold)
    const r = this.e.SuperFluxExtractor(vec, 20, 2048, 256, 16, sampleRate, threshold)
    const onsets = Array.from(this.fromVec(r.onsets)) as number[]
    r.onsets.delete()
    return onsets
  }

  /**
   * Compute windowed spectrum for a single FRAME_SIZE frame.
   * Returns WasmVector — caller must delete.
   */
  computeSpectrum(frameArr: Float32Array, frameSize: number): WasmVector {
    const fv = this.toVec(frameArr)
    // Windowing(signal, normalized=true, size, type='hann', zeroPadding=false)
    const windowed = this.e.Windowing(fv, true, frameSize, 'hann', false)
    fv.delete()
    // Spectrum(signal, size) → { spectrum }
    const specRes = this.e.Spectrum(windowed.frame, frameSize)
    windowed.frame.delete()
    return specRes.spectrum
  }

  /**
   * Extract MFCC timbre from a spectrum vector.
   * Returns 12 coefficients. Deletes all intermediate vectors.
   * Caller must delete the spectrum vector after this call.
   */
  extractMfcc(spectrum: WasmVector, sampleRate: number, frameSize: number): number[] {
    // MFCC(spectrum, dctType=2, highFrequencyBound=SR/2, inputSize=FRAME_SIZE/2+1,
    //      liftering=0, logType='dbamp', lowFrequencyBound=0, normalize='unit_sum',
    //      numberBands=40, numberCoefficients=13, sampleRate, ...)
    const r = this.e.MFCC(
      spectrum,
      2, sampleRate / 2, frameSize / 2 + 1, 0, 'dbamp', 0,
      'unit_sum', 40, 13, sampleRate,
    )
    const coeffs = Array.from(this.fromVec(r.mfcc)) as number[]
    r.mfcc.delete()
    r.bands.delete()
    return coeffs.slice(0, 12)
  }

  /**
   * Extract HPCP chroma from a spectrum vector.
   * Returns 12 values normalized so max=1.0 (matches Spotify convention).
   * Deletes all intermediate vectors. Caller must delete spectrum after.
   */
  extractHpcp(spectrum: WasmVector, sampleRate: number): number[] {
    // SpectralPeaks(spectrum, magnitudeThreshold=0, maxFrequency=SR/2, maxPeaks=100,
    //               minFrequency=0, orderBy='magnitude', sampleRate)
    const peaks = this.e.SpectralPeaks(spectrum, 0, sampleRate / 2, 100, 0, 'magnitude', sampleRate)
    // HPCP(frequencies, magnitudes, bandPreset=true, bandSplitFrequency=500, harmonics=0,
    //      maxFrequency=SR/2, maxShifted=false, minFrequency=40, nonLinear=false,
    //      normalized='unitMax', referenceFrequency=440, sampleRate, size=12,
    //      weightType='squaredCosine', windowSize=1)
    const hpcpRes = this.e.HPCP(
      peaks.frequencies, peaks.magnitudes,
      true, 500, 0, sampleRate / 2, false, 40, false,
      'unitMax', 440, sampleRate, 12,
    )
    const pitches = Array.from(this.fromVec(hpcpRes.hpcp)) as number[]
    peaks.frequencies.delete()
    peaks.magnitudes.delete()
    hpcpRes.hpcp.delete()
    return pitches
  }

  /**
   * Convenience: compute both MFCC and HPCP from a single spectrum.
   * More efficient than calling separately (computes spectrum once).
   */
  extractSpectralFeatures(frameArr: Float32Array, sampleRate: number, frameSize: number): SpectralFrame {
    const spec = this.computeSpectrum(frameArr, frameSize)
    const timbre = this.extractMfcc(spec, sampleRate, frameSize)
    const pitches = this.extractHpcp(spec, sampleRate)
    spec.delete()
    return { timbre, pitches }
  }
}
