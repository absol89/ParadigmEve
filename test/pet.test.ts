import {describe,it,expect} from 'vitest';
import {PetMachine,clampPosition,readPreference,animationFrame,animationDuration} from '../src/renderer/pet-machine.js';
import type {PetAnimationManifest} from '../src/shared/pets.js';
import manifestJson from './fixtures/pet-animations.json';
const manifest=manifestJson as unknown as PetAnimationManifest;
const create=()=>new PetMachine({visible:true,x:180,y:300},1000,800,()=>.5,manifest);
const advance=(pet:PetMachine,ms:number)=>{while(ms>0){const dt=Math.min(ms,100);pet.tick(dt);ms-=dt;}};
describe('desktop pet animation owner',()=>{
  it('spawns into idle and uses authored per-frame durations',()=>{
    const pet=create();expect(pet.frame).toBe(0);advance(pet,500);expect(pet.state).toBe('idle');
    expect(animationFrame('punch',0,false,manifest)).toBe(38);expect(animationFrame('punch',210,false,manifest)).toBe(40);
    expect(animationFrame('heavy',animationDuration('heavy',manifest)+100,false,manifest)).toBe(65);
    expect(animationFrame('walk',animationDuration('walk',manifest),false,manifest)).toBe(12);
  });
  it('advances a deliberate long hold in full and parks settled held/reduced poses',()=>{
    const pet=create();
    for(const duration of manifest.animations.spawn.ms)pet.tick(duration);
    expect(pet.state).toBe('idle');expect(pet.nextUpdateIn).toBe(600);
    pet.tick(600);expect(pet.frame).toBe(5);expect(pet.nextUpdateIn).toBe(200);
    pet.beginPointer(1,{x:0,y:0});expect(pet.nextUpdateIn).toBe(Infinity);
    pet.movePointer(1,{x:20,y:0});
    for(const duration of manifest.animations.held.ms)pet.tick(duration);
    expect(pet.frame).toBe(23);expect(pet.nextUpdateIn).toBe(Infinity);
    pet.setReducedMotion(true);expect(pet.nextUpdateIn).toBe(Infinity);
    pet.poke();expect(pet.nextUpdateIn).toBe(animationDuration('look',manifest));
    pet.tick(pet.nextUpdateIn);expect(pet.state).toBe('idle');expect(pet.nextUpdateIn).toBe(Infinity);
  });
  it('uses each imported manifest as the scheduling authority',()=>{
    const custom=structuredClone(manifest) as unknown as PetAnimationManifest;
    custom.animations.spawn.ms[0]=937;
    const pet=new PetMachine({visible:true,x:180,y:300},1000,800,()=>.5,custom);
    expect(pet.nextUpdateIn).toBe(937);
    pet.tick(937);
    expect(pet.frame).toBe(1);
  });
  it('does not start the old bug/TODO action scenes',()=>{
    const pet=create();
    expect(pet.startAction('bat')).toBe(false);
    expect(pet.startAction('toss')).toBe(false);
    expect(pet.scene).toBeNull();
  });
  it('distinguishes jitter clicks from drags, and rejects foreign pointer events',()=>{
    const pet=create();pet.beginPointer(1,{x:10,y:10});pet.movePointer(9,{x:200,y:10});
    pet.movePointer(1,{x:13,y:12});pet.endPointer(1);expect(pet.state).toBe('look');expect(pet.position.x).toBe(180);
    pet.beginPointer(2,{x:10,y:10});pet.movePointer(2,{x:40,y:20});expect(pet.state).toBe('held');
    pet.endPointer(2);expect(pet.state).toBe('landing');expect(pet.position).toEqual({x:210,y:310});
  });
  it('cancelled pointer events never turn into pokes',()=>{
    const pet=create();advance(pet,500);pet.beginPointer(1,{x:0,y:0});pet.endPointer(1,true);expect(pet.state).toBe('idle');
  });
  it('clicks only trigger a gentle look instead of escalating reactions',()=>{
    const pet=create();for(let n=0;n<6;n++)pet.poke();expect(pet.state).toBe('look');expect(pet.scene).toBeNull();
  });
  it('clamps positions including corrupt input and tiny viewports',()=>{
    expect(clampPosition({x:999,y:-20},800,600)).toEqual({x:640,y:0});
    expect(clampPosition({x:NaN,y:Infinity},20,20)).toEqual({x:0,y:0});
    const pet=create();pet.resize(150,150);expect(pet.position).toEqual({x:0,y:0});expect(pet.scene).toBeNull();
  });
  it('round-trips only validated visibility and position preferences',()=>{
    const pet=create();pet.hide();expect(readPreference(JSON.stringify(pet.preference),1000,800)).toEqual(pet.preference);
    expect(readPreference('{bad',1000,800).visible).toBe(false);
    expect(readPreference('{"visible":"yes","x":1,"y":2}',1000,800).visible).toBe(false);
    expect(readPreference('{"visible":true,"x":9000,"y":9000}',1000,800)).toEqual({visible:true,x:840,y:640});
  });
  it('stays limited to idle/look/walk motion over long autonomous runs',()=>{
    const pet=create();advance(pet,120000);expect(pet.scene).toBeNull();expect(['idle','look','walk']).toContain(pet.state);
  });
  it('reduced motion cancels travel and prevents autonomous motion',()=>{
    const pet=create();pet.setReducedMotion(true);expect(pet.scene).toBeNull();
    advance(pet,100000);expect(pet.state).toBe('idle');expect(pet.frame).toBe(7);expect(pet.startAction('bat')).toBe(false);
    pet.beginPointer(1,{x:0,y:0});pet.movePointer(1,{x:20,y:20});expect(pet.frame).toBe(23);
  });
  it('declares 96 unique bounded frames and valid timings, independent of batches',()=>{
    const frames=Object.values(manifest.animations).flatMap(a=>a.frames);
    expect(new Set(frames).size).toBe(96);expect(frames.toSorted((a,b)=>a-b)).toEqual(Array.from({length:96},(_,i)=>i));
    for(const clip of Object.values(manifest.animations)){expect(clip.frames.length).toBe(clip.ms.length);expect(clip.ms.every(ms=>ms>0)).toBe(true);}
    expect(manifest.animations.punch.frames.length).toBe(18);expect(manifest.animations.heavy.frames.length).toBe(10);
    expect(manifest.width).toBe(manifest.columns*manifest.cellWidth);expect(manifest.height/manifest.cellHeight*manifest.columns).toBe(96);
  });
});
