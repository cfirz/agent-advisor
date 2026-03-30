@echo off
:: Agent Dashboard — Install hooks into Claude Code global settings
:: Requires Node.js (already used by the dashboard server)

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is required but not found in PATH.
    exit /b 1
)

set "ADVISOR_DIR=%~dp0"

node -e "const fs=require('fs'),path=require('path'),p=path.join(process.env.USERPROFILE,'.claude','settings.json'),dir=(process.env.ADVISOR_DIR||'').replace(/\\/g,'/').replace(/\/$/,''),srv=dir+'/server/server.mjs',cmd='curl -s http://localhost:8099/api/state > /dev/null 2>&1 || node \x22'+srv+'\x22 & curl -sf --max-time 10 --retry 5 --retry-delay 1 --retry-connrefused -X POST http://localhost:8099/hooks/register-project -H \x22Content-Type: application/json\x22 -d \x22{\\\x22cwd\\\x22:\x22$CLAUDE_PROJECT_DIR\x22}\x22 > /dev/null 2>&1 || true';const hooks={SessionStart:[{hooks:[{type:'command',command:cmd},{type:'http',url:'http://localhost:8099/hooks/session-start'}]}],SubagentStart:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/subagent-start'}]}],SubagentStop:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/subagent-stop'}]}],PreToolUse:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/pre-tool-use'}]}],PostToolUse:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/post-tool-use'}]}],PostToolUseFailure:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/post-tool-use-failure'}]}],Stop:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/stop'}]}],Notification:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/notification'}]}],SessionEnd:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/session-end'}]}]};let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}if(!s.hooks)s.hooks={};for(const[k,v]of Object.entries(hooks)){if(!s.hooks[k])s.hooks[k]=[];if(k==='SessionStart'){s.hooks[k]=s.hooks[k].filter(e=>!(e.hooks&&e.hooks.some(h=>h.command&&h.command.includes('localhost:8099'))));s.hooks[k].push(...v)}else{const exists=s.hooks[k].some(e=>e.hooks&&e.hooks.some(h=>(h.url&&h.url.includes('localhost:8099'))||(h.command&&h.command.includes('localhost:8099'))));if(!exists)s.hooks[k].push(...v)}}fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2));console.log('Hooks installed to '+p);console.log('Server: '+srv);console.log('Restart Claude Code for changes to take effect.')"

pause
