import * as THREE from "three";

export type CharacterActionTrack =
  | {
    target: string;
    property: "rotation";
    times: readonly number[];
    values: ReadonlyArray<readonly [number, number, number]>;
  }
  | {
    target: string;
    property: "position";
    times: readonly number[];
    values: ReadonlyArray<readonly [number, number, number]>;
  };

/** Renderer-agnostic action description compiled to Three.js clips at runtime. */
export interface CharacterActionSpec {
  id: string;
  label: string;
  duration: number;
  loop: boolean;
  expose?: boolean;
  returnToDefault?: boolean;
  /** Optional per-action entry blend. Zero is valid for collision-critical poses. */
  fadeSeconds?: number;
  tracks: readonly CharacterActionTrack[];
}

export interface CharacterAnimationController {
  actions: ReadonlyArray<{ id: string; label: string; loop: boolean }>;
  readonly active: string;
  play(name: string): void;
  stop(): void;
  update(deltaSeconds: number): void;
  subscribe(listener: (active: string) => void): () => void;
}

export interface CompiledCharacterActions {
  clips: ReadonlyMap<string, THREE.AnimationClip>;
  mixer: THREE.AnimationMixer;
  controller: CharacterAnimationController;
}

export class CharacterAnimationRuntime {
  readonly mixer: THREE.AnimationMixer;

  constructor(root: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(root);
  }

  play(clip: THREE.AnimationClip, fadeSeconds = 0.15): THREE.AnimationAction {
    const action = this.mixer.clipAction(clip);
    action.reset().fadeIn(fadeSeconds).play();
    return action;
  }

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
  }

  stopAll(): void {
    this.mixer.stopAllAction();
  }
}

/**
 * Compile plain tuple tracks into an AnimationMixer-backed controller. The
 * default action is normally a subtle idle loop; one-shots can either return
 * to it or clamp on their final frame (for example a death pose).
 */
export function compileCharacterActions(
  root: THREE.Object3D,
  specs: readonly CharacterActionSpec[],
  defaultActionId = "idle",
  fadeSeconds = 0.14,
): CompiledCharacterActions {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  if (byId.size !== specs.length) throw new Error("character action ids must be unique");
  if (!byId.has(defaultActionId)) throw new Error(`default character action is missing: ${defaultActionId}`);

  const clips = new Map<string, THREE.AnimationClip>();
  for (const spec of specs) {
    if (!(spec.duration > 0)) throw new Error(`character action ${spec.id} has a non-positive duration`);
    const tracks = spec.tracks.map((track) => compileTrack(spec.id, track));
    clips.set(spec.id, new THREE.AnimationClip(spec.id, spec.duration, tracks));
  }
  root.animations = [...clips.values()];

  const mixer = new THREE.AnimationMixer(root);
  const mixerActions = new Map<string, THREE.AnimationAction>();
  for (const spec of specs) {
    const action = mixer.clipAction(clips.get(spec.id)!);
    if (spec.loop) action.setLoop(THREE.LoopRepeat, Infinity);
    else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    mixerActions.set(spec.id, action);
  }

  const listeners = new Set<(active: string) => void>();
  let active = defaultActionId;
  let current = mixerActions.get(defaultActionId)!;
  let remaining = 0;
  current.reset().setEffectiveWeight(1).play();

  const notify = (): void => listeners.forEach((listener) => listener(active));
  const transition = (nextId: string, duration?: number): void => {
    const nextSpec = byId.get(nextId);
    const next = mixerActions.get(nextId);
    if (!nextSpec || !next) throw new Error(`unknown character action: ${nextId}`);
    const transitionDuration = duration ?? nextSpec.fadeSeconds ?? fadeSeconds;
    if (transitionDuration < 0) throw new Error(`character action ${nextId} has a negative fade duration`);
    if (next === current && nextId === active) return;
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
    current.crossFadeTo(next, transitionDuration, false);
    current = next;
    active = nextId;
    remaining = !nextSpec.loop && nextSpec.returnToDefault ? nextSpec.duration : 0;
    notify();
  };

  const controller: CharacterAnimationController = {
    actions: specs
      .filter((spec) => spec.id !== defaultActionId && spec.expose !== false)
      .map(({ id, label, loop }) => ({ id, label, loop })),
    get active() { return active; },
    play: (name) => transition(name),
    stop: () => transition(defaultActionId, Math.min(fadeSeconds, 0.12)),
    update: (deltaSeconds) => {
      const safeDelta = Math.min(0.05, Math.max(0, deltaSeconds));
      mixer.update(safeDelta);
      if (remaining <= 0 || safeDelta <= 0) return;
      remaining -= safeDelta;
      if (remaining <= 0) transition(defaultActionId);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };
  return { clips, mixer, controller };
}

function compileTrack(actionId: string, track: CharacterActionTrack): THREE.KeyframeTrack {
  if (track.times.length !== track.values.length || track.times.length < 2) {
    throw new Error(`character action ${actionId} track ${track.target}.${track.property} has mismatched samples`);
  }
  for (let index = 1; index < track.times.length; index += 1) {
    if (track.times[index] <= track.times[index - 1]) {
      throw new Error(`character action ${actionId} track times must be strictly increasing`);
    }
  }
  if (track.property === "position") {
    return new THREE.VectorKeyframeTrack(
      `${track.target}.position`,
      [...track.times],
      track.values.flatMap((value) => [...value]),
    );
  }
  const values = track.values.flatMap(([x, y, z]) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ"));
    return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  });
  return new THREE.QuaternionKeyframeTrack(`${track.target}.quaternion`, [...track.times], values);
}
