import { CONFIG } from '../src/config';
import { createGame, update, commandToRunway, toggleHold, commandTakeoff } from '../src/sim';

function nearestEnd(ac: any, rw: any): 0 | 1 {
  return Math.hypot(ac.x - rw.ends[0].finalEntry.x, ac.y - rw.ends[0].finalEntry.y) <= Math.hypot(ac.x - rw.ends[1].finalEntry.x, ac.y - rw.ends[1].finalEntry.y) ? 0 : 1;
}

const state = createGame(CONFIG.defaultSeed);
for (let step = 0; step < 60*150; step++) {
  if (step % 30 === 0) {
    for (const ac of state.aircraft) {
      if (!ac.conflict) continue;
      const rw = ac.assignedRunwayId != null ? state.runways.find(r => r.id === ac.assignedRunwayId) : undefined;
      const th = rw && ac.assignedEnd != null ? rw.ends[ac.assignedEnd].threshold : null;
      const nearTouchdown = th && Math.hypot(ac.x - th.x, ac.y - th.y) < 110;
      if (ac.phase !== 'holding' && !nearTouchdown) toggleHold(state, ac.id);
    }
    
    for (const rw of state.runways) {
      const inUse = state.aircraft.some(a => a.assignedRunwayId === rw.id && (a.phase === 'approach' || a.phase === 'taxiOut' || a.phase === 'holdShort' || a.phase === 'lineUpWait' || a.phase === 'takeoff'));
      if (inUse || state.time < rw.occupiedUntil) continue;
      const arr = state.aircraft.find(a => a.assignedRunwayId == null && (a.phase === 'inbound' || a.phase === 'holding') && !a.conflict);
      if (arr) {
        commandToRunway(state, arr.id, rw.id, nearestEnd(arr, rw));
        continue;
      }
      const dep = state.aircraft.find(a => a.phase === 'readyDep');
      if (dep) {
        commandToRunway(state, dep.id, rw.id, nearestEnd(dep, rw));
      }
    }
    for (const ac of state.aircraft) {
      if (ac.phase === 'lineUpWait') {
        const approach = state.aircraft.some((a) => a.phase === 'approach' && a.assignedRunwayId === ac.assignedRunwayId);
        if (!approach) commandTakeoff(state, ac.id);
      }
    }
    for (const ac of state.aircraft) {
      if (ac.phase !== 'inbound') continue;
      if (ac.assignedRunwayId != null || ac.conflict) continue;
      toggleHold(state, ac.id);
    }
  }
  
  update(state, 1/60);
  
  for (const e of state.events) {
    if (e.kind === 'crash' || e.kind === 'groundCrash') {
      console.log(`CRASH at ${state.time.toFixed(1)}:`, e);
      for (const a of state.aircraft) {
         if (a.conflict || a.phase === 'landing' || a.phase === 'takeoff' || a.phase === 'lineUpWait') {
            console.log(`  AC ${a.id}: phase=${a.phase}, conflict=${a.conflict}, x=${a.x.toFixed(0)}, y=${a.y.toFixed(0)}`);
         }
      }
    }
  }
  state.events = [];
  if (state.status === 'fired') break;
}
