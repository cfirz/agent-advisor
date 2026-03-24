@echo off
:: Agent Dashboard — Install hooks into Claude Code global settings
:: Requires Node.js (already used by the dashboard server)

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is required but not found in PATH.
    exit /b 1
)

node -e "const fs=require('fs'),p=require('path').join(process.env.USERPROFILE,'.claude','settings.json');const hooks={SubagentStart:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/subagent-start'}]}],SubagentStop:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/subagent-stop'}]}],PreToolUse:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/pre-tool-use'}]}],PostToolUse:[{hooks:[{type:'http',url:'http://localhost:8099/hooks/post-tool-use'}]}]};let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}if(!s.hooks)s.hooks={};for(const[k,v]of Object.entries(hooks)){if(!s.hooks[k])s.hooks[k]=[];const exists=s.hooks[k].some(e=>e.hooks&&e.hooks.some(h=>h.url&&h.url.includes('localhost:8099')));if(!exists)s.hooks[k].push(...v)}fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2));console.log('Hooks installed to '+p);console.log('Restart Claude Code for changes to take effect.')"

pause
