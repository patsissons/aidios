import { uploadAndAnalyze } from './api'
import { prepareTrack, updateThreshold, applyBranchFilters, computeStats } from './jukebox'
import { Visualization } from './visualization'
import { Player } from './player'
import type { AudioAnalysis, JukeboxTrack, TuneParams } from './types'
import { DEFAULT_TUNE } from './types'

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $uploadSection = document.getElementById('upload-section')!
const $playerSection = document.getElementById('player-section')!
const $uploadZone = document.getElementById('upload-zone')!
const $fileInput = document.getElementById('file-input') as HTMLInputElement
const $progressContainer = document.getElementById('upload-progress')!
const $progressBar = document.getElementById('progress-bar')!
const $progressText = document.getElementById('progress-text')!
const $canvas = document.getElementById('viz-canvas') as HTMLCanvasElement
const $playBtn = document.getElementById('play-btn')!
const $tuneBtn = document.getElementById('tune-btn')!
const $tunePanel = document.getElementById('tune-panel')!
const $listenTime = document.getElementById('listen-time')!
const $beatCount = document.getElementById('beat-count')!

// Tune controls
const $threshSlider = document.getElementById('thresh-slider') as HTMLInputElement
const $threshVal = document.getElementById('thresh-val')!
const $probMinSlider = document.getElementById('prob-min-slider') as HTMLInputElement
const $probMinVal = document.getElementById('prob-min-val')!
const $probMaxSlider = document.getElementById('prob-max-slider') as HTMLInputElement
const $probMaxVal = document.getElementById('prob-max-val')!
const $rampSlider = document.getElementById('ramp-slider') as HTMLInputElement
const $rampVal = document.getElementById('ramp-val')!
const $volSlider = document.getElementById('vol-slider') as HTMLInputElement
const $volVal = document.getElementById('vol-val')!
const $lookaheadSlider = document.getElementById('lookahead-slider') as HTMLInputElement
const $lookaheadVal = document.getElementById('lookahead-val')!
const $crossfadeSlider = document.getElementById('crossfade-slider') as HTMLInputElement
const $crossfadeVal = document.getElementById('crossfade-val')!
const $prerollSlider = document.getElementById('preroll-slider') as HTMLInputElement
const $prerollVal = document.getElementById('preroll-val')!
const $targetOffsetSlider = document.getElementById('target-offset-slider') as HTMLInputElement
const $targetOffsetVal = document.getElementById('target-offset-val')!
const $fadeCurveSelect = document.getElementById('fade-curve-select') as HTMLSelectElement
const $optLoopExt = document.getElementById('opt-loop-ext') as HTMLInputElement
const $optReverse = document.getElementById('opt-reverse') as HTMLInputElement
const $optLong = document.getElementById('opt-long') as HTMLInputElement
const $optNoSeq = document.getElementById('opt-no-seq') as HTMLInputElement
const $resetBtn = document.getElementById('reset-btn')!
const $closeTuneBtn = document.getElementById('close-tune-btn')!

// Stats
const $statChance = document.getElementById('stat-chance')!
const $statThresh = document.getElementById('stat-thresh')!
const $statDuration = document.getElementById('stat-duration')!
const $statBeats = document.getElementById('stat-beats')!
const $statBranches = document.getElementById('stat-branches')!
const $statLongestLoop = document.getElementById('stat-longest-loop')!
const $statLongestPct = document.getElementById('stat-longest-pct')!

// ─── State ──────────────────────────────────────────────────────────────────

let analysis: AudioAnalysis | null = null
let track: JukeboxTrack | null = null
let audioFile: File | null = null
let params: TuneParams = { ...DEFAULT_TUNE }
let currentThreshold = 0

const viz = new Visualization($canvas)
const player = new Player()

// ─── Upload flow ────────────────────────────────────────────────────────────

$uploadZone.addEventListener('click', () => $fileInput.click())
$fileInput.addEventListener('change', () => {
  if ($fileInput.files?.[0]) handleFile($fileInput.files[0])
})

$uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  $uploadZone.classList.add('drag-over')
})
$uploadZone.addEventListener('dragleave', () => {
  $uploadZone.classList.remove('drag-over')
})
$uploadZone.addEventListener('drop', (e) => {
  e.preventDefault()
  $uploadZone.classList.remove('drag-over')
  if (e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0])
})

async function handleFile(file: File): Promise<void> {
  audioFile = file
  $progressContainer.hidden = false
  $uploadZone.style.display = 'none'

  try {
    // Start audio decode in parallel with server analysis
    const decodePromise = player.loadAudio(file)

    analysis = await uploadAndAnalyze(file, (status) => {
      $progressText.textContent = status
      // Animate progress bar
      if (status.includes('Uploading')) {
        $progressBar.style.setProperty('--progress', '30%')
      } else if (status.includes('Analyzing')) {
        $progressBar.style.setProperty('--progress', '70%')
      } else {
        $progressBar.style.setProperty('--progress', '100%')
      }
    })

    await decodePromise
    initializePlayer()
  } catch (err) {
    $progressText.textContent = `Error: ${err instanceof Error ? err.message : err}`
    $progressText.style.color = '#e55'
  }
}

function initializePlayer(): void {
  if (!analysis) return

  // Prepare the jukebox track with default threshold
  params = { ...DEFAULT_TUNE }
  track = prepareTrack(analysis, params.threshold)
  currentThreshold = params.threshold

  // Switch to player view FIRST so canvas has dimensions
  $uploadSection.hidden = true
  $playerSection.hidden = false

  // Set up visualization (needs visible canvas for layout)
  viz.setTrack(track)
  viz.onBeatSeek((idx) => player.seekTo(idx))

  // Set up player
  player.setTrack(track)
  player.setParams(params)
  player.onEvent((e) => {
    if (e.type === 'beat') {
      viz.setCurrentBeat(e.beat.which, e.isBranch)
    }
    if (e.type === 'stop') {
      $playBtn.textContent = 'Play'
      $playBtn.classList.remove('playing')
    }
  })
  syncUIToParams()

  // Update stats
  updateStats()
  updateStatsDuration()
}

// ─── Playback controls ──────────────────────────────────────────────────────

$playBtn.addEventListener('click', () => {
  player.toggle()
  if (player.isPlaying()) {
    $playBtn.textContent = 'Pause'
    $playBtn.classList.add('playing')
    startTimeUpdater()
  } else {
    $playBtn.textContent = 'Play'
    $playBtn.classList.remove('playing')
  }
})

let timeUpdater: number | null = null
function startTimeUpdater(): void {
  if (timeUpdater) return
  timeUpdater = window.setInterval(() => {
    if (!player.isPlaying()) {
      if (timeUpdater) { clearInterval(timeUpdater); timeUpdater = null }
      return
    }
    const secs = Math.floor(player.getListenTime())
    const m = Math.floor(secs / 60)
    const s = secs % 60
    $listenTime.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    $beatCount.textContent = String(player.getBeatsPlayed())
    $statChance.textContent = String(Math.round(params.minBranchProb * 100))
  }, 250)
}

// ─── Tune panel ─────────────────────────────────────────────────────────────

$tuneBtn.addEventListener('click', () => {
  $tunePanel.hidden = !$tunePanel.hidden
})
$closeTuneBtn.addEventListener('click', () => {
  $tunePanel.hidden = true
})

// Threshold
$threshSlider.addEventListener('input', () => {
  const val = Number($threshSlider.value)
  $threshVal.textContent = String(val)
  params.threshold = val
  rebuildNeighbors()
})

// Probability range
$probMinSlider.addEventListener('input', () => {
  const val = Number($probMinSlider.value)
  $probMinVal.textContent = String(val)
  params.minBranchProb = val / 100
  player.setParams(params)
})
$probMaxSlider.addEventListener('input', () => {
  const val = Number($probMaxSlider.value)
  $probMaxVal.textContent = String(val)
  params.maxBranchProb = val / 100
  player.setParams(params)
})

// Ramp-up speed
$rampSlider.addEventListener('input', () => {
  const val = Number($rampSlider.value)
  $rampVal.textContent = String(val)
  params.rampUpSpeed = val / 1000  // scale: 1-100 → 0.001-0.1
  player.setParams(params)
})

// Volume
$volSlider.addEventListener('input', () => {
  const val = Number($volSlider.value)
  $volVal.textContent = String(val)
  params.volume = val / 100
  player.setParams(params)
})

// Advanced transition settings
$lookaheadSlider.addEventListener('input', () => {
  const val = Number($lookaheadSlider.value)
  $lookaheadVal.textContent = String(val)
  params.scheduleAheadMs = val
  player.setTransitionParams(params)
})
$crossfadeSlider.addEventListener('input', () => {
  const val = Number($crossfadeSlider.value)
  $crossfadeVal.textContent = String(val)
  params.branchCrossfadeMs = val
  player.setTransitionParams(params)
})
$prerollSlider.addEventListener('input', () => {
  const val = Number($prerollSlider.value)
  $prerollVal.textContent = String(val)
  params.branchPreRollMs = val
  player.setTransitionParams(params)
})
$targetOffsetSlider.addEventListener('input', () => {
  const val = Number($targetOffsetSlider.value)
  $targetOffsetVal.textContent = String(val)
  params.branchTargetOffsetMs = val
  player.setTransitionParams(params)
})
$fadeCurveSelect.addEventListener('change', () => {
  params.fadeCurve = $fadeCurveSelect.value as TuneParams['fadeCurve']
  player.setTransitionParams(params)
})

// Checkboxes
$optLoopExt.addEventListener('change', () => { params.loopExtension = $optLoopExt.checked; rebuildNeighbors() })
$optReverse.addEventListener('change', () => { params.reverseOnly = $optReverse.checked; rebuildNeighbors() })
$optLong.addEventListener('change', () => { params.longOnly = $optLong.checked; rebuildNeighbors() })
$optNoSeq.addEventListener('change', () => { params.noSequential = $optNoSeq.checked; rebuildNeighbors() })

// Reset
$resetBtn.addEventListener('click', () => {
  params = { ...DEFAULT_TUNE }
  syncUIToParams()
  rebuildNeighbors()
  viz.reset()
  player.stop()
  $playBtn.textContent = 'Play'
  $playBtn.classList.remove('playing')
})

function syncUIToParams(): void {
  $threshSlider.value = String(params.threshold)
  $threshVal.textContent = String(params.threshold)
  $probMinSlider.value = String(Math.round(params.minBranchProb * 100))
  $probMinVal.textContent = String(Math.round(params.minBranchProb * 100))
  $probMaxSlider.value = String(Math.round(params.maxBranchProb * 100))
  $probMaxVal.textContent = String(Math.round(params.maxBranchProb * 100))
  $rampSlider.value = String(Math.round(params.rampUpSpeed * 1000))
  $rampVal.textContent = String(Math.round(params.rampUpSpeed * 1000))
  $volSlider.value = String(Math.round(params.volume * 100))
  $volVal.textContent = String(Math.round(params.volume * 100))
  $lookaheadSlider.value = String(params.scheduleAheadMs)
  $lookaheadVal.textContent = String(params.scheduleAheadMs)
  $crossfadeSlider.value = String(params.branchCrossfadeMs)
  $crossfadeVal.textContent = String(params.branchCrossfadeMs)
  $prerollSlider.value = String(params.branchPreRollMs)
  $prerollVal.textContent = String(params.branchPreRollMs)
  $targetOffsetSlider.value = String(params.branchTargetOffsetMs)
  $targetOffsetVal.textContent = String(params.branchTargetOffsetMs)
  $fadeCurveSelect.value = params.fadeCurve
  $optLoopExt.checked = params.loopExtension
  $optReverse.checked = params.reverseOnly
  $optLong.checked = params.longOnly
  $optNoSeq.checked = params.noSequential
  player.setParams(params)
}

function rebuildNeighbors(): void {
  if (!track) return
  const result = updateThreshold(track, params.threshold)
  currentThreshold = result.threshold
  applyBranchFilters(track, params)
  viz.refresh()
  updateStats()
}

function updateStats(): void {
  if (!track) return
  const stats = computeStats(track)
  $statThresh.textContent = String(currentThreshold)
  $statBeats.textContent = String(stats.totalBeats)
  $statBranches.textContent = String(stats.totalBranches)
  $statLongestLoop.textContent = String(stats.longestLoop)
  $statLongestPct.textContent = String(stats.longestLoopPct)
}

function updateStatsDuration(): void {
  if (!analysis) return
  const secs = Math.floor(analysis.track.duration)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  $statDuration.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
