const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {spawnSync} = require('node:child_process')
const T = require('./build-tools.cjs')

exports.run = platform => {
  const name = platform === 'darwin' ? 'macos' : 'linux'
  if (process.platform !== platform || !process.env.npm_execpath) throw Error(`Run npm run test:${name} on ${name}.`)
  const directory = path.join(T.ROOT, 'test/.work', name)
  fs.mkdirSync(directory, {recursive:true})
  const reportFile = path.join(directory, 'report.json')
  const report = {startedAt:new Date().toISOString(),os:os.release(),arch:process.arch,node:process.version,sourceHash:T.sourceHash(),complete:false,checks:[]}
  const save = () => { fs.writeFileSync(reportFile+'.tmp',JSON.stringify(report,null,2)+'\n');fs.renameSync(reportFile+'.tmp',reportFile) }
  save()
  function check(name, args) {
    const log = path.join(directory,name.replaceAll(':','-')+'.log'), fd = fs.openSync(log,'w'), started = Date.now()
    console.log(`Running ${name}...`)
    const result = spawnSync(process.execPath,args,{cwd:T.ROOT,env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'},stdio:['ignore',fd,fd],timeout:10*60_000})
    fs.closeSync(fd)
    if(result.error)fs.appendFileSync(log,'\n'+result.error.message+'\n')
    const passed = result.status === 0 && !result.error
    report.checks.push({script:name,passed,code:result.status,signal:result.signal,ms:Date.now()-started,log});save()
    console.log(`${passed?'PASS':'FAIL'} ${name} (${Math.round((Date.now()-started)/1000)}s)`)
    if(!passed)console.error(fs.readFileSync(log,'utf8').slice(-16000))
  }
  // Package first: native helper tests use the binaries that will be shipped.
  const checks = [['typecheck'],['dist','--',platform==='darwin'?'--mac':'--linux'],['test'],
    ['test:ui'],['test:native'],['test:tray'],['test:dictation:ui']]
  for(const [script,...args] of checks)check(script,[process.env.npm_execpath,'run',script,...args])
  report.complete = true;report.finishedAt = new Date().toISOString();report.sourceUnchanged = report.sourceHash === T.sourceHash();save()
  const failed = report.checks.filter(c=>!c.passed).length
  console.log(`${report.checks.length-failed}/${report.checks.length} checks passed. Report: ${reportFile}`)
  if(!report.sourceUnchanged)console.error('Source changed during verification. Repeat against the final source.')
  process.exitCode = failed || !report.sourceUnchanged ? 1 : 0
}
