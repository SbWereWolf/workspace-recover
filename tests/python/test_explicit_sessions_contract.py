"""External explicit-session contract checks; original test bundle unchanged."""
import hashlib,json,os,re,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
COMMAND=json.loads(os.environ.get('WR_TEST_COMMAND_JSON',json.dumps([sys.executable,'-I','-B','-m','workspace_recover'])))
RUN=Path(tempfile.mkdtemp(prefix='wr-explicit-sessions-',dir=os.environ.get('WR_TEST_ARTIFACTS')))
class ExplicitSessionChecks(unittest.TestCase):
 def setUp(self):
  self.root=RUN/self._testMethodName;self.root.mkdir();self.calls=[]
  self.env={k:v for k,v in os.environ.items() if k not in ('PYTHONPATH','PYTHONHOME')}
  self.env.update(WORKSPACE_RECOVER_STATE_DIR=str(self.root/'state'),WORKSPACE_RECOVER_CONFIG_DIR=str(self.root/'config'),WORKSPACE_RECOVER_CACHE_DIR=str(self.root/'cache'))
 def invoke(self,*args,cwd=None,exit=0,command=None):
  r=subprocess.run([*COMMAND,*map(str,args)] if command is None else command,cwd=cwd or self.root,env=self.env,capture_output=True,timeout=30)
  n=len(self.calls)+1;(self.root/f'{n}.stdout').write_bytes(r.stdout);(self.root/f'{n}.stderr').write_bytes(r.stderr)
  self.calls.append({'argv':args,'exit':r.returncode,'cwd':str(cwd or self.root)})
  (self.root/'calls.json').write_text(json.dumps(self.calls,default=str,indent=2)+'\n')
  self.assertEqual(r.returncode,exit,(r.stdout,r.stderr))
  records=[line[9:] for line in r.stderr.decode().splitlines() if line.startswith('Session: ')]
  self.assertEqual(len(records),1,r.stderr)
  ref=json.loads(records[0]);self.assertEqual(set(ref),{'sessionId','sessionPath'})
  return r,ref
 def init(self,name):
  p=self.root/name;p.mkdir();r,ref=self.invoke('init','local','--set','backupRoot='+str(self.root/'backups'/name),'--non-interactive',cwd=p)
  self.assertRegex(ref['sessionId'],r'^wr_i_\d{14}_[a-f0-9]{12}$');self.assertTrue(Path(ref['sessionPath']).is_file());self.assertIn(ref['sessionId'],r.stdout.decode());return p,ref
 def test_no_implicit_selection_even_with_stale_pointer(self):
  p,a=self.init('a');_,b=self.init('b');self.assertFalse((self.root/'state/current').exists())
  d=self.root/'state/current';d.mkdir();fake=d/(hashlib.sha256(str(p).encode()).hexdigest()+'.json');fake.write_text(json.dumps({'schema':'workspace-recover/current-session/v3','sessionId':b['sessionId'],'scope':str(p)}));before=fake.read_bytes()
  sub=p/'nested';sub.mkdir()
  for cwd in (p,sub):
   for command in ('info','status','next','continue'):
    r,ref=self.invoke(command,cwd=cwd,exit=1);self.assertIn(b'requires an explicit session ID',r.stderr);self.assertEqual(ref,{'sessionId':None,'sessionPath':None})
  self.assertEqual(fake.read_bytes(),before)
  for command in ('info','status','next','continue'):
   _,ref=self.invoke(command,a['sessionId'],cwd=sub);self.assertEqual(ref,a)
 def test_all_legacy_result_views_keep_explicit_reference(self):
  p,a=self.init('a');_,b=self.init('b')
  for command in [('info',a['sessionId']),('status',a['sessionId']),('next',a['sessionId']),('continue',a['sessionId']),('info',a['sessionId'],'--type','init','--view','short'),('info',a['sessionId'],'--type','init','--view','medium')]:
   _,ref=self.invoke(*command);self.assertEqual(ref,a)
  for args in [('info',a['sessionId'],'--view','full'),('info',a['sessionId'],'--type','init','--view','full')]:
   r,ref=self.invoke(*args);self.assertEqual(ref,a);self.assertEqual(len(r.stdout.splitlines()),1);self.assertTrue(Path(r.stdout.decode().strip()).is_file())
  _,ref=self.invoke('info',b['sessionId'],'--view','unsupported',exit=1);self.assertEqual(ref,b)
 def test_created_operation_failure_returns_record(self):
  _,ref=self.invoke('restore','--manifest',self.root/'absent.json',exit=1)
  self.assertIsNotNone(ref['sessionId']);state=json.loads(Path(ref['sessionPath']).read_text());self.assertEqual(state['state'],'failed');self.assertEqual(state['id'],ref['sessionId']);self.assertFalse((self.root/'state/current').exists())
 def test_stateless_and_invalid_commands_report_null(self):
  cases=[(('--help',),0),(('--version',),0),(('flow','--help'),0),(('template','list'),0),(('template','describe','local'),0),(('profile','list'),0),(('auth','profiles'),0),(('auth','status'),0),(('unknown',),1),(('info','--unknown'),1),(('flow','status'),1),(('info','bad-id'),1)]
  for args,code in cases:
   _,ref=self.invoke(*args,exit=code);self.assertEqual(ref,{'sessionId':None,'sessionPath':None})
  r,ref=self.invoke('flow','template');self.assertEqual(json.loads(r.stdout)['schema'],'workspace-recover/flow/v3');self.assertIsNone(ref['sessionId'])
  caps=self.root/'caps.json';caps.write_text(json.dumps({'schema':'workspace-recover/bridge-capabilities/v3','account':'test@example.com','operations':['drive.metadata']}))
  for args in [('bridge','init','--bridge',str(self.root/'bridge'),'--capabilities',str(caps)),('bridge','pending','--bridge',str(self.root/'bridge'))]:
   _,ref=self.invoke(*args);self.assertEqual(ref,{'sessionId':None,'sessionPath':None})
 def test_flow_identity_on_success_host_and_failure(self):
  m=self.root/'manifest.json';m.write_text(json.dumps({'schema':'workspace-recover/flow/v3','steps':[{'id':'first','op':'command','argv':['/usr/bin/false']},{'id':'second','op':'command','argv':['/usr/bin/false']}]}));s=self.root/'session'
  r,ref=self.invoke('flow','run','--manifest',m,'--session',s);state=json.loads(r.stdout);self.assertEqual(state['status'],'COMPLETED_WITH_OBSERVATIONS');self.assertEqual(len(state['results']),2);self.assertEqual(ref,{'sessionId':state['sessionId'],'sessionPath':str(s)})
  for args in [('status',),('host-plan',),('host-claim',)]:
   _,selected=self.invoke('flow',*args,'--session',s);self.assertEqual(selected,ref)
  _,selected=self.invoke('flow','decide','--session',s,'--request','wrong','--choice','skip',exit=1);self.assertEqual(selected,ref)
  before=(s/'state.json').read_bytes()
  for action in ('run','status','unknown'):
   failed,selected=self.invoke('flow',action,'--session',s,'--limit','not-a-number',exit=1)
   self.assertEqual(selected,ref);self.assertEqual(failed.stdout,b'');self.assertIn(b'invalid literal for int()',failed.stderr)
   self.assertEqual((s/'state.json').read_bytes(),before)
  missing=self.root/'missing-session';_,selected=self.invoke('flow','status','--session',missing,exit=1);self.assertEqual(selected,{'sessionId':None,'sessionPath':str(missing)})
 def test_missing_npm_python_still_reports_no_session(self):
  package=ROOT;fake=self.root/'package'
  for name in ('bin/workspace-recover.mjs','scripts/npm-runtime.cjs'):
   target=fake/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(package/name,target)
  _,ref=self.invoke(command=['node',str(fake/'bin/workspace-recover.mjs'),'--version'],exit=2);self.assertEqual(ref,{'sessionId':None,'sessionPath':None})
if __name__=='__main__':unittest.main(verbosity=2)
