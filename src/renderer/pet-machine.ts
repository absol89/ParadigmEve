import type { PetAnimationManifest, PetAnimationName } from '../shared/pets.js';

export type PetAnimation = PetAnimationName;
/** Ported from Chat On Steroids: `bat` swings at a word (walk → angry → punch → heavy → celebrate); `toss` bins one (walk → grab → carry → throw → celebrate). */
export type PetAction = 'bat' | 'toss';
export interface Point { x: number; y: number }
export interface PetPreference extends Point { visible: boolean }
export const PET_SIZE = 160;
export const DRAG_DISTANCE = 6;
export function clampPosition(p: Point, width: number, height: number): Point {
  return { x: Math.round(Math.max(0, Math.min(Number.isFinite(p.x) ? p.x : 0, Math.max(0,width-PET_SIZE)))),
    y: Math.round(Math.max(0, Math.min(Number.isFinite(p.y) ? p.y : 0, Math.max(0,height-PET_SIZE)))) };
}
export function readPreference(raw: string | null, width: number, height: number): PetPreference {
  const fallback = {visible:false,x:Math.max(0,width-200),y:Math.max(0,height-230)};
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value.visible !== 'boolean' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return fallback;
    return {...clampPosition(value,width,height),visible:value.visible};
  } catch { return fallback; }
}
export function animationDuration(name: PetAnimation, authored: PetAnimationManifest): number { return authored.animations[name].ms.reduce((a,b)=>a+b,0); }
export function animationFrame(name: PetAnimation, elapsed: number, reduced: boolean, authored: PetAnimationManifest): number {
  const clip = authored.animations[name];
  if (reduced) return name === 'held' ? 23 : name === 'poke' ? 28 : name === 'angry' ? 32 : 7;
  let time = clip.loop ? elapsed % animationDuration(name, authored) : Math.min(elapsed,animationDuration(name, authored)-1);
  for(let i=0;i<clip.frames.length;i++) { time -= clip.ms[i]!; if(time<0) return clip.frames[i]!; }
  return clip.frames.at(-1)!;
}
function nextFrameIn(name: PetAnimation, elapsed: number, authored: PetAnimationManifest): number {
  const clip=authored.animations[name];
  let time=clip.loop?elapsed%animationDuration(name,authored):elapsed;
  for(let i=0;i<clip.frames.length;i++){
    if(!clip.loop && i===clip.frames.length-1)return Infinity;
    if(time<clip.ms[i]!)return clip.ms[i]!-time;
    time-=clip.ms[i]!;
  }
  return Infinity;
}
interface Phase { animation: PetAnimation; duration: number; distance?: number }
export interface ActionScene { kind: PetAction; phase: number; target: Point; bin: Point; from: Point; facing: 1|-1 }
interface Pointer { id: number; start: Point; origin: Point; dragging: boolean }

/** One clock and owner for animation, gestures, autonomous decisions and props. */
export class PetMachine {
  state: PetAnimation | 'hidden';
  elapsed = 0;
  position: Point;
  facing: 1|-1 = 1;
  scene: ActionScene | null = null;
  pointer: Pointer | null = null;
  reducedMotion = false;
  clock = 0;
  nextDecision = 2500;
  private phases: Phase[] = [];
  private walkOrigin: Point;
  private walkDistance = 0;
  private walkDuration = 0;
  private mood = 0;
  constructor(preference: PetPreference, public width: number, public height: number, private random: ()=>number, readonly manifest: PetAnimationManifest) {
    this.position = clampPosition(preference,width,height); this.walkOrigin = {...this.position};
    this.state = preference.visible ? 'spawn' : 'hidden';
  }
  get visible(): boolean { return this.state !== 'hidden'; }
  get frame(): number { return this.state==='hidden' ? 7 : animationFrame(this.state,this.elapsed,this.reducedMotion,this.manifest); }
  get preference(): PetPreference { return {...this.position,visible:this.visible}; }
  /** Zero needs continuous motion; Infinity is static until an interaction.
   * Otherwise the authored frame, phase or autonomous decision owns the wake. */
  get nextUpdateIn(): number {
    if(this.state==='hidden' || this.pointer && !this.pointer.dragging)return Infinity;
    if(this.state==='walk' || this.scene && ['grab','carry','throw'].includes(this.state))return 0;
    const frame=this.reducedMotion?Infinity:nextFrameIn(this.state,this.elapsed,this.manifest);
    if(this.scene)return Math.max(0,Math.min(frame,this.phases[this.scene.phase]!.duration-this.elapsed));
    if(this.state==='held')return frame;
    if(this.state!=='idle')return Math.max(0,Math.min(frame,animationDuration(this.state,this.manifest)-this.elapsed));
    return this.reducedMotion?Infinity:Math.max(0,Math.min(frame,this.nextDecision-this.clock));
  }
  private enter(state: PetAnimation): void { this.state=state; this.elapsed=0; }
  private cancel(): void { this.scene=null; this.phases=[]; this.walkDistance=0; }
  private rest(): void { this.enter('idle'); this.nextDecision=this.clock+2500+this.random()*3500; }
  show(): void { if(this.visible)return; this.cancel(); this.enter('spawn'); }
  hide(): void { this.cancel(); this.pointer=null; this.state='hidden';this.elapsed=0; }
  reset(): void { this.cancel();this.pointer=null;this.position=clampPosition({x:this.width-200,y:this.height-230},this.width,this.height);if(this.visible)this.rest(); }
  resize(width:number,height:number): void { this.width=width;this.height=height;this.position=clampPosition(this.position,width,height);this.cancel();this.pointer=null;if(this.visible)this.rest(); }
  setReducedMotion(value:boolean): void { this.reducedMotion=value;this.cancel();this.pointer=null;if(this.visible)this.rest(); }
  beginPointer(id:number,p:Point): boolean { if(!this.visible || this.pointer)return false;this.pointer={id,start:p,origin:{...this.position},dragging:false};return true; }
  movePointer(id:number,p:Point): void {
    const pointer=this.pointer;if(pointer?.id!==id)return;
    const dx=p.x-pointer.start.x,dy=p.y-pointer.start.y;
    if(!pointer.dragging && Math.hypot(dx,dy)<DRAG_DISTANCE)return;
    if(!pointer.dragging){pointer.dragging=true;this.cancel();this.enter('held');}
    this.position=clampPosition({x:pointer.origin.x+dx,y:pointer.origin.y+dy},this.width,this.height);
  }
  endPointer(id:number,cancelled=false): void {
    const pointer=this.pointer;if(pointer?.id!==id)return;this.pointer=null;
    if(pointer.dragging){this.enter('landing');}
    else if(!cancelled)this.poke();
  }
  poke(): void {
    if(!this.visible || this.pointer)return;
    this.cancel();this.enter('look');
  }
  react(animation: 'spawn' | 'look' | 'angry' | 'celebrate'): void {
    if(!this.visible || this.pointer || this.scene || !['idle','look'].includes(this.state))return;
    this.cancel();this.enter(animation);
  }
  startAction(kind:PetAction): boolean {
    void kind;
    return false;
  }
  tick(milliseconds:number): void {
    if(!this.visible)return;
    // A deliberate frame hold (e.g. 600 ms breathing) is elapsed animation time.
    // Keep the existing 100 ms stall allowance beyond the requested wake; normal
    // continuous movement still cannot jump across a long renderer suspension.
    const dt=Math.max(0,Math.min(Number.isFinite(milliseconds)?milliseconds:0,this.nextUpdateIn+100));this.clock+=dt;
    if(this.pointer && !this.pointer.dragging)return;
    this.elapsed+=dt;
    if(this.scene){
      const phase=this.phases[this.scene.phase]!;
      if(phase.distance)this.position=clampPosition({x:this.scene.from.x+this.facing*phase.distance*Math.min(1,this.elapsed/phase.duration),y:this.position.y},this.width,this.height);
      if(this.elapsed>=phase.duration){
        this.scene.phase++;this.scene.from={...this.position};const next=this.phases[this.scene.phase];
        if(next)this.enter(next.animation);else{this.cancel();this.rest();}
      }return;
    }
    if(this.state==='held')return;
    if(this.state==='walk'){
      this.position=clampPosition({x:this.walkOrigin.x+this.walkDistance*Math.min(1,this.elapsed/this.walkDuration),y:this.position.y},this.width,this.height);
      if(this.elapsed>=this.walkDuration)this.rest();return;
    }
    if(this.state!=='idle') { if(this.elapsed>=animationDuration(this.state as PetAnimation,this.manifest))this.rest();return; }
    if(this.reducedMotion || this.pointer)return;
    if(this.clock>=this.nextDecision){
      this.mood=(this.mood+1)%3;
      if(this.mood===1)this.enter('look');
      else if(this.mood===2){
        this.facing=this.random()<.5?-1:1;this.walkOrigin={...this.position};
        const end=clampPosition({x:this.position.x+this.facing*(28+this.random()*42),y:this.position.y},this.width,this.height);
        this.walkDistance=end.x-this.position.x;this.walkDuration=760*2;this.enter('walk');
      } else this.rest();
    }
  }
}
