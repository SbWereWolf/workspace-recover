import path from 'node:path';
import { LocalFilesProvider } from '../providers/local-files.mjs';
import { GoogleWorkspaceProvider, googleAuthStatus } from '../providers/google-workspace.mjs';
import { ConnectorProvider } from '../providers/connector.mjs';
import { ConnectorBoundary, canonical, validateCapabilities } from './bridge.mjs';
import { assertFormat, schema } from './formats.mjs';
import { pathExists, readJson, sha256Text, writeJsonAtomic } from './util.mjs';

export function providerContext(store,session,role,requiredOperations,execution={}) {
  return {...execution,sessionId:session.id,sessionDir:store.directory(session.id),role,requiredOperations,
    onPending:async(request,bridge)=>{
      (session.externalRequests??={})[request.requestId]={operation:request.operation,state:'pending',requestHash:request.requestHash};
      session.state='waiting_for_connector';
      session.next={type:'automatic',action:'host-connectors',bridge,command:`workspace-recover bridge pending --bridge ${JSON.stringify(bridge)}`,requestId:request.requestId};
      const fullPath=await store.write(session.id,'connector-exchanges.json',{schema:schema('connector-exchanges'),requests:session.connectorRecords??={}});
      session.connectorRecords[request.requestId]={request};
      await store.write(session.id,'connector-exchanges.json',{schema:schema('connector-exchanges'),requests:session.connectorRecords});
      session.info.connector={short:'Host operations pending',medium:`${request.operation}: ${request.requestId}`,fullPath};
      await store.save(session);
    },
    onResolved:async(request,answer)=>{
      (session.externalRequests??={})[request.requestId]={operation:request.operation,state:'completed',requestHash:request.requestHash};
      session.connectorRecords??={};session.connectorRecords[request.requestId]={request,response:answer};
      const fullPath=await store.write(session.id,'connector-exchanges.json',{schema:schema('connector-exchanges'),requests:session.connectorRecords});
      session.info.connector={short:`${Object.keys(session.connectorRecords).length} host operation record(s)`,medium:Object.values(session.connectorRecords).map(x=>`${x.request.operation}: ${x.response?.status||'pending'}`).join('\n'),fullPath};
      session.state='running';session.next=null;await store.save(session);
    },
    onRoute:async(route)=>{(session.executors??={})[role]=route;await store.save(session);},
  };
}
/** Keep Google resource identity separate from this machine's execution policy. */
export function resourceProvider(config) {
  if(config.type==='google-workspace')return {type:config.type,...(config.folderId?{folderId:config.folderId}:{})};
  const {executor,bridge,account,waitTimeoutMs,...resource}=config;return resource;
}

class RoutedProvider {
  constructor(config) {this.type='google-workspace';this.config=config;this.executor=config.executor;}
  async resolve() {
    if(this.delegate)return this.delegate;
    const c=this.config;const requested=c.executor;
    if(!['direct','connector','delegated','auto'].includes(requested))throw new Error(`unsupported executor: ${requested}`);
    const file=c.sessionDir?path.join(c.sessionDir,'executors',`${c.role||'google'}.json`):null;
    const policy={requested,bridge:c.bridge||null,account:c.account||null,profile:c.profile||'default',operations:c.requiredOperations||[]};
    const policySha256=sha256Text(canonical(policy));let route;
    if(file&&await pathExists(file)) {
      route=assertFormat(await readJson(file),'executor-route');
      if(route.policySha256!==policySha256)throw new Error('frozen executor policy changed');
    } else {
      let mode=requested,account=c.account||null;
      if(mode==='auto') {
        if(c.bridge&&await pathExists(path.join(c.bridge,'capabilities.json'))) {
          const cap=validateCapabilities(await readJson(path.join(c.bridge,'capabilities.json')));
          if(c.account&&c.account!==cap.account)throw new Error('auto connector account mismatch');
          if((c.requiredOperations||[]).every(op=>cap.operations.includes(op))) {mode='connector';account=cap.account;}
        }
        if(mode==='auto') {
          const auth=await googleAuthStatus(c.profile||'default');
          if(auth.clientPresent&&auth.tokenPresent)mode='direct';
          else throw new ConnectorBoundary('No complete registered connector or configured direct profile','CAPABILITY_REQUIRED');
        }
      }
      route={schema:schema('executor-route'),mode,account,policySha256};
      // Resolve capability identity before freezing the route, not after first write.
      if(mode==='connector'||mode==='delegated') {
        const probe=new ConnectorProvider({...c,executor:mode,account});const ready=await probe.ready();route.account=ready.account;this.delegate=probe;
      }
      if(file)await writeJsonAtomic(file,route);
    }
    if(!this.delegate) {
      this.delegate=route.mode==='direct'?new GoogleWorkspaceProvider(c):new ConnectorProvider({...c,executor:route.mode,account:route.account});
    }
    this.executor=route.mode;if(c.onRoute)await c.onRoute(route);return this.delegate;
  }
  async ready(){return (await this.resolve()).ready();}
  async upload(...a){return (await this.resolve()).upload(...a);}
  async download(...a){return (await this.resolve()).download(...a);}
  async metadata(...a){return (await this.resolve()).metadata(...a);}
  async sendHandoff(...a){return (await this.resolve()).sendHandoff(...a);}
  async readHandoff(...a){return (await this.resolve()).readHandoff(...a);}
}
export function providerFromConfig(config,overrides={}) {
  if(!config?.type)throw new Error('provider type is required');
  const merged={...config,...overrides};
  if(config.type==='local-files')return new LocalFilesProvider(merged);
  if(config.type==='google-workspace')return merged.executor?new RoutedProvider(merged):new GoogleWorkspaceProvider(merged);
  throw new Error(`unsupported provider type: ${config.type}`);
}
export function handoffProviderFromReference(reference,{googleProfile='default',...context}={}) {
  if(/^https:\/\/mail\.google\.com\//.test(reference)||/^[0-9a-f]{12,}$/i.test(reference))return providerFromConfig({type:'google-workspace',profile:googleProfile},context);
  if(/^https?:/.test(reference))throw new Error('unsupported handoff URL host/protocol');
  return new LocalFilesProvider({root:'.',handoffRoot:'.',readOnly:true});
}
