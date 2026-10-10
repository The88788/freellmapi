import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ProviderPacingCore, PacingError, pacingBucketKey, validatePacingConfig } from '../../services/provider-pacing-core.js';

class FakeClock {
  ms=0;
  tasks = new Map();
  next=1;
  now(){return this.ms}
  setTimeout(fn,delay){ const n=this.next++;this.tasks.set(n,{at:this.ms+delay,fn}); return n;}
  clearTimeout(n){this.tasks.delete(n)}
  tick(to){assert.ok(to >= this.ms);
    for (;;) {
      const s=[...this.tasks.entries()].filter(([id,t])=>t.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!s)break;
      this.ms=s[1].at;this.tasks.delete(s[0]);s[1].fn();
    }this.ms=to;
  }
}
const id=(n=1,modelId='muse:glimmer')=>({platform:'pollinations',modelId,keyId:n,endpointScope:'api:v1'});
const rule=(overrides={})=>({id:'muse-rule',enabled:true,scope:'model-key',match:{platform:'pollinations',modelId:'muse:glimmer',keyId:1},limits:{minStartIntervalMs:65000},queue:{maxWaitMs:180000,maxPendingPerBucket:20},...overrides});
const cfg=(rules=[rule()], extras={})=>({enabled:true,maxPendingGlobal:200,maxPendingPerClient:10,rules,...extras});
const req=(i=1,client='Harness',extra={})=>({identity:id(i),clientId:client,estimatedTokens:500,...extra});
const assertErr=async (p,code)=>{await assert.rejects(p,e=>e instanceof PacingError&&e.code===code)};

test('65000 ms starts, FIFO, no provisional lease while queued', async ()=>{
 const clock=new FakeClock(), s=new ProviderPacingCore(cfg(),{clock});
 const p1=s.schedule(req()),p2=s.schedule(req(1,'Codex')),p3=s.schedule(req());
 let states=[];const g1=await p1;states.push(g1.startedAtMs);assert.equal(s.status().inflight,1);assert.equal(s.status().pending,2);
 let received2=false;p2.then(()=>received2=true);clock.tick(64999);await Promise.resolve();assert.equal(received2,false);
 clock.tick(65000);const g2=await p2;states.push(g2.startedAtMs);
 clock.tick(130000);const g3=await p3;states.push(g3.startedAtMs);
 assert.deepEqual(states,[0,65000,130000]);assert.equal(s.status().inflight,3);
 g1.release();g2.release();g3.release();assert.equal(s.status().inflight,0);
 assert.equal(s.counters().enqueued,2);s.shutdown();
});

test('other model and provider unaffected, qualified identity',async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg(),{clock});
 const g=await s.schedule(req());
 const otherModel=await s.schedule({identity:id(1,'other'),clientId:'Codex',estimatedTokens:3});
 const otherProvider=await s.schedule({identity:{...id(),platform:'nvidia'},clientId:'Harness',estimatedTokens:3});
 assert.equal(otherModel.startedAtMs,0);assert.deepEqual(otherProvider.policyIds,[]);
 assert.equal(s.status().pending,0);g.release();otherModel.release();otherProvider.release();s.shutdown();
});

test('20 callers cannot share min interval admission', async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg([rule({limits:{minStartIntervalMs:1000},queue:{maxWaitMs:30000,maxPendingPerBucket:30}})],{maxPendingPerClient:30}),{clock});
 const p=Array.from({length:20},(_,i)=>s.schedule(req(1,`client${i}`)));
 for(let i=1;i<20;i++) clock.tick(i*1000);
 const grants=await Promise.all(p);assert.deepEqual(grants.map(g=>g.startedAtMs),Array.from({length:20},(_,i)=>i*1000));
 assert.equal(s.status().pending,0);for(const g of grants)g.release();s.shutdown();
});

test('shared account across keys; private keys separate',async()=>{
 const clock=new FakeClock(),sr=rule({id:'acc',scope:'account',match:{platform:'pollinations',accountId:'shared'},limits:{minStartIntervalMs:65000}});
 const s=new ProviderPacingCore(cfg([sr]),{clock});
 const p1=s.schedule({...req(),identity:{...id(1),accountId:'shared'}});
 const p2=s.schedule({...req(2,'Codex'),identity:{...id(2),accountId:'shared'}});
 const p3=s.schedule({...req(3,'other'),identity:{...id(3),accountId:'independent'}});
 const g1=await p1,g3=await p3;assert.deepEqual(g3.policyIds,[]);clock.tick(65000);const g2=await p2;assert.equal(g2.startedAtMs,65000);
 for(const g of [g1,g2,g3])g.release();s.shutdown();
});

test('concurrency requires release, even after 2 minutes',async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg([rule({limits:{maxConcurrent:1},queue:{maxWaitMs:300000,maxPendingPerBucket:10}})]),{clock});
 const p1=s.schedule(req());const p2=s.schedule(req(1,'Codex'));const g1=await p1;
 clock.tick(150000);assert.equal(s.status().pending,1);assert.equal(s.status().inflight,1);
 g1.release();const g2=await p2;assert.equal(g2.startedAtMs,150000);g2.release();s.shutdown();
});

test('RPM sliding window and TPM settle accounting',async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg([rule({limits:{rpm:2,tpm:1000},queue:{maxWaitMs:180000,maxPendingPerBucket:10}})]),{clock});
 const a=await s.schedule(req());const b=await s.schedule(req(1,'Codex'));a.release(600);b.release(200);
 const p=s.schedule(req());assert.equal(s.status().pending,1);
 clock.tick(60000);const c=await p;assert.equal(c.startedAtMs,60000);c.release();s.shutdown();
});

test('oversized predicted TPM fails without queue',async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg([rule({limits:{tpm:450}})]),{clock});
 await assertErr(s.schedule(req()),'quota_too_large');assert.equal(s.status().pending,0);s.shutdown();
});

test('cancellation removes waiter and does not begin upstream',async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg(),{clock}),ac=new AbortController();
 const g=await s.schedule(req());const p=s.schedule(req(1,'Codex',{signal:ac.signal}));assert.equal(s.status().pending,1);
 ac.abort();await assertErr(p,'client_cancelled');assert.equal(s.status().pending,0);clock.tick(130000);
 assert.equal(s.counters().admitted,1);g.release();s.shutdown();
});

test('bounded queue and deadline have distinct errors',async()=>{
 const clock=new FakeClock();const s=new ProviderPacingCore(cfg([rule({queue:{maxWaitMs:100,maxPendingPerBucket:1}})]),{clock});
 const g=await s.schedule(req());const pending=s.schedule(req(1,'Codex'));
 await assertErr(s.schedule(req(1,'Harness2')),'queue_overloaded');
 clock.tick(100);await assertErr(pending,'rate_limit_exceeded');assert.equal(s.status().pending,0);g.release();s.shutdown();
});

test('shutdown cancels queued requests, release remains idempotent',async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg(),{clock});const g=await s.schedule(req());const p=s.schedule(req(1,'Codex'));
 s.shutdown();await assertErr(p,'queue_stopped');g.release();g.release();assert.equal(s.status().inflight,0);
 await assertErr(s.schedule(req()),'queue_stopped');
});

test('one atomic durable commit for all scopes, restoring after restart',async()=>{
 const clock=new FakeClock();const db=new Map(),commits=[];
 const store={readNextEligible:k=>db.get(k)??0,commitStarts:changes=>{commits.push(changes);for(const v of changes)db.set(v.bucketKey,v.nextEligibleAtMs)}};
 const rules=[rule(),{id:'provider',enabled:true,scope:'provider',match:{platform:'pollinations'},limits:{minStartIntervalMs:3000},queue:{maxWaitMs:180000,maxPendingPerBucket:20}}];
 const s1=new ProviderPacingCore(cfg(rules),{clock,store});const g=await s1.schedule(req());assert.equal(commits.length,1);assert.equal(commits[0].length,2);
 s1.shutdown();g.release();clock.tick(10000);
 const s2=new ProviderPacingCore(cfg(rules),{clock,store});const p=s2.schedule(req());assert.equal(s2.status().pending,1);
 clock.tick(65000);const g2=await p;assert.equal(g2.startedAtMs,65000);g2.release();s2.shutdown();
});

test('durable write fail-closed and zero reservation',async()=>{
 const clock=new FakeClock(),s=new ProviderPacingCore(cfg(),{clock,store:{readNextEligible:()=>0,commitStarts:()=>{throw Error('DB unavailable')}}});
 await assertErr(s.schedule(req()),'pacing_store_error');assert.equal(s.status().inflight,0);assert.equal(s.status().pending,0);s.shutdown();
});

test('scope key collisions impossible; invalid configuration rejected',async()=>{
 const r=rule();assert.notEqual(pacingBucketKey(r,id(1,'muse:glimmer')),pacingBucketKey(r,{...id(),endpointScope:'api:v2'}));
 assert.throws(()=>validatePacingConfig(cfg([rule({limits:{minStartIntervalMs:0}})])),{code:'invalid_policy'});
 assert.throws(()=>validatePacingConfig(cfg([rule(),rule()])),{code:'invalid_policy'});
});