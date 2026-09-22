import path from 'node:path';
import fsp from 'node:fs/promises';
import { runFlow, flowStatus, decideFlow, hostPlan, claimHost, replyFlow, recordPresented } from './engine.mjs';

export const defaultTemplate = {
  schema:'workspace-recover/flow/v3',
  _comment:'Consider running your project automated tests after recovery, when applicable.',
  steps:[]
};
const usage=`workspace-recover flow run --manifest FILE --session DIR [--workspace DIR] [--bridge DIR] [--limit N]
workspace-recover flow run --session DIR
workspace-recover flow status --session DIR
workspace-recover flow decide --session DIR --request ID --choice CHOICE [--params JSON]
workspace-recover flow presented --session DIR --request ID
workspace-recover flow host-plan --session DIR
workspace-recover flow host-claim --session DIR
workspace-recover flow reply --session DIR --result RAW_RESULT.json [--path MATERIALIZED_FILE]
workspace-recover flow template [--output FILE]
`;
export async function flowMain(argv) {
  const action=argv.shift();if(!action||action==='help'||action==='--help'){console.log(usage);return 0;}
  const options={};
  const known=new Set(['manifest','session','workspace','bridge','limit','request','choice','params','result','path','output','attachments']);
  for(let i=0;i<argv.length;i++){
    const key=argv[i].replace(/^--/,'');if(!known.has(key)||!argv[i].startsWith('--')||argv[i+1]===undefined)throw new Error(`Invalid option ${argv[i]}`);
    options[key]=argv[++i];
  }
  if(action==='template'){
    const text=JSON.stringify(defaultTemplate,null,2)+'\n';
    if(options.output)await fsp.writeFile(options.output,text,{flag:'wx'});else process.stdout.write(text);
    return 0;
  }
  if(!options.session)throw new Error('A session location is needed: --session DIR.');
  const directory=path.resolve(options.session),limit=options.limit===undefined?Infinity:Number(options.limit);
  let result;
  if(action==='run')result=await runFlow({directory,limit,workspace:options.workspace,bridge:options.bridge,
    manifestPath:options.manifest?path.resolve(options.manifest):null,
    manifest:options.manifest?JSON.parse((await fsp.readFile(options.manifest,'utf8')).replace(/^\uFEFF/,'')):undefined});
  else if(action==='status')result=await flowStatus(directory);
  else if(action==='decide')result=await decideFlow({directory,limit,requestId:options.request,choice:options.choice,params:JSON.parse(options.params||'{}')});
  else if(action==='presented')result=await recordPresented({directory,requestId:options.request});
  else if(action==='host-plan')result=await hostPlan(directory);
  else if(action==='host-claim')result=await claimHost(directory);
  else if(action==='reply'){
    if(!options.result)throw new Error('Pass raw connector output with --result FILE.');
    result=await replyFlow({directory,result:JSON.parse(await fsp.readFile(options.result,'utf8')),downloadPath:options.path,attachments:options.attachments?JSON.parse(await fsp.readFile(options.attachments,'utf8')):[]});
  }else throw new Error(`Unknown flow command: ${action}`);
  console.log(JSON.stringify(result,null,2));
  // Flow progress is not a business acceptance decision. Failed operations remain in results.
  return ({WAITING_DECISION:10,WAITING_HOST:11,WAITING_RETRY:12,BUSY:13,PAUSED:14,STOPPED:15})[result.status]??0;
}
