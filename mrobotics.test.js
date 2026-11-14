import test from "node:test";
import assert from "node:assert/strict";
import { createMroboticsClient } from "./controllers/retailer/mroboticsClient.js";
import { validateRechargeResponse } from "./controllers/retailer/mroboticsController.js";
const config=()=>({token:"private-api-token"});
test("MRobotics uses POST form fields and never sends a token in the URL",async()=>{
 let seen;
 const client=createMroboticsClient({config,transport:async(url,options)=>{seen={url,options};return {ok:true,json:async()=>({status:"pending"})};}});
 await client.submit({mobile_no:"9876543210",order_id:"100001",is_stv:"true"});
 assert.equal(seen.url,"https://mrobotics.in/api/recharge");assert.equal(seen.options.method,"POST");
 const body=new URLSearchParams(seen.options.body);assert.equal(body.get('api_token'),"private-api-token");assert.equal(body.get('is_stv'),"true");assert.ok(!seen.url.includes('token'));
 await client.status('100001');assert.equal(seen.url,"https://mrobotics.in/api/order_id_status");assert.equal(new URLSearchParams(seen.options.body).get('order_id'),'100001');
});
test("MRobotics never retries ambiguous submit responses",async()=>{
 let count=0;const client=createMroboticsClient({config,transport:async()=>{count++;throw Error('timeout');}});
 await assert.rejects(client.submit({}),{status:503});assert.equal(count,1);
});
test("MRobotics rejects HTML, redirects and malformed JSON results",async()=>{
 for(const reply of [{ok:false},{ok:true,json:async()=>{throw Error('HTML');}},{ok:true,json:async()=>[]}]){
  const client=createMroboticsClient({config,transport:async()=>reply});await assert.rejects(client.status('1'),{status:502});
 }
});
test("MRobotics settlement requires matching recipient, amount and stable reference",()=>{
 const payment={recipient:'9876543210',amount:'299.00'};const submission={order_id:'100001'};
 const good={status:'success',mobile_no:payment.recipient,amount:299,id:123,order_id:submission.order_id,tnx_id:'OP123'};
 assert.equal(validateRechargeResponse(good,payment,submission).status,'success');
 for(const change of [{status:'successful'},{mobile_no:'9999999999'},{amount:300},{id:null},{order_id:'999'}])assert.throws(()=>validateRechargeResponse({...good,...change},payment,submission));
 assert.throws(()=>validateRechargeResponse(good,payment,{...submission,provider_id:'999'}));
});
