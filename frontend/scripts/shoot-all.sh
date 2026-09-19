#!/usr/bin/env bash
# Reproduce the seven canonical visual reviews (visual-reviews/01..07) against a running backend (:8000) + vite (:5173).
# Base scenario = flagship Toronto event egress; branch = storm hazard child scenario ($STORM), if present.
set -euo pipefail
cd "$(dirname "$0")/.."
STORM="${STORM:-$(curl -s localhost:8000/api/scenarios | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).filter(x=>x.hazards?.length&&x.pack_id==="toronto");console.log(a.length?a[a.length-1].scenario_id:"")})')}"
ST='window.__cityshift.store.getState()'
SLEEP='new Promise(r=>setTimeout(r,3500))'

node scripts/shoot.mjs 01-city-clean --t=0 --key=1
node scripts/shoot.mjs 02-city-running --t=900 --key=1 --play --playfor=2500
node scripts/shoot.mjs 03-crowd --t=360 --key=2 --play --playfor=2000
node scripts/shoot.mjs 04-agent-selected --t=1000 \
  --eval="(() => { const s=$ST; const rx=s.replays[s.primaryRunId]; const ride=(s.scenarios,Object.values(rx.tracks)).filter(x=>x.track.kind==='person' && x.times.some(t=>t>980&&t<1000)); const id=(ride[3]??ride[0]).track.entity_id; s.select({kind:'person', id}); return id })()" \
  --key=4 --eval="$SLEEP"
node scripts/shoot.mjs 05-intervention-preview --t=600 --click="button[title='Closure']" \
  --click="button.listitem:has-text('King St W')" --click=".tool button.primary" \
  --eval="new Promise(r=>setTimeout(r,9000))" --key=2 --eval="$SLEEP"
if [ -n "$STORM" ]; then
  node scripts/shoot.mjs 06-tornado --wait=7000 \
    --eval="$ST.selectScenario('$STORM').then(()=>$ST.primaryRunId)" --eval="new Promise(r=>setTimeout(r,4000))" \
    --eval="window.__cityshift.seek(1260); window.__cityshift.camera({center:[-79.383,43.6432],zoom:15.6,pitch:62,bearing:-25},'incident'); 'ok'" \
    --eval="$SLEEP" --play --playfor=1500
fi
node scripts/shoot.mjs 07-compare --t=900 \
  --eval="(() => { const s=$ST; const done=s.runs.filter(r=>r.status==='completed'); const base=done.find(r=>r.plan_id==='baseline'); const cand=done.find(r=>r.plan_id!=='baseline'); return Promise.all([s.openRun(cand.run_id,'primary'), s.openRun(base.run_id,'compare')]).then(()=>{ s.setCompareMode(true); return [cand.run_id, base.run_id] }) })()" \
  --eval="$SLEEP" --key=1 --play --playfor=2000
