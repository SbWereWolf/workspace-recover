import { assertFormat, schema, assertRequirements } from './formats.mjs';
import { validateWorkflow } from './workflow.mjs';
import { validateReporter } from './reporting.mjs';

/** Compile author-friendly declarations once; executors receive explicit argv only. */
export function compileManifest(document) {
  assertFormat(document,'manifest');assertRequirements(document.requires);
  const manifest=structuredClone(document);
  const actions=manifest.actions || {}, reporters=manifest.reporters || {};
  const validId=id=>typeof id==='string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) && !['__proto__','constructor','prototype'].includes(id);
  if(Array.isArray(actions) || typeof actions!=='object' || Array.isArray(reporters) || typeof reporters!=='object')throw new Error('actions and reporters must be objects');
  for(const id of [...Object.keys(actions),...Object.keys(reporters)])if(!validId(id))throw new Error('unsafe declaration ID');
  const workflow=manifest.restore?.workflow || [];
  if(!Array.isArray(workflow))throw new Error('workflow must be an array');
  const expanded=workflow.map(item=>{
    let step;
    const name=typeof item==='string'?item:item?.action;
    if(name!==undefined){
      if(!Object.hasOwn(actions,name))throw new Error(`unknown action: ${name}`);
      if(!actions[name] || typeof actions[name]!=='object' || Array.isArray(actions[name]))throw new Error(`invalid action: ${name}`);
      step={...structuredClone(actions[name]),id:name,...(typeof item==='object'?item:{})};delete step.action;
    }else step=structuredClone(item);
    if(step?.exec!==undefined){if(step.argv!==undefined)throw new Error(`action ${step.id} declares both exec and argv`);step.argv=step.exec;delete step.exec;}
    if(typeof step?.report==='string'){
      if(!Object.hasOwn(reporters,step.report))throw new Error(`unknown reporter: ${step.report}`);
      step.report=structuredClone(reporters[step.report]);
    }
    if(step?.report)validateReporter(step.report);
    return step;
  });
  validateWorkflow(expanded);
  manifest.restore={...manifest.restore,workflow:expanded};
  delete manifest.actions;delete manifest.reporters;
  manifest.requires??={formatVersion:3,features:['advisory-workflow','saved-reports']};
  return manifest;
}
