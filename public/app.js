let currentUser = JSON.parse(localStorage.getItem("bslUser") || "null");
let adminToken = localStorage.getItem("bslAdminToken") || null;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
function toast(msg){const t=$("#toast");t.textContent=msg;t.style.display="block";setTimeout(()=>t.style.display="none",2500)}
function api(url,opts={}){const{headers,...rest}=opts;return fetch(url,{headers:{"Content-Type":"application/json",...(headers||{})},...rest}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Something went wrong");return d})}

function go(view){$$(".view").forEach(v=>v.classList.remove("active"));$("#"+view).classList.add("active");if(view==="matches")loadMatches();if(view==="leaderboard")loadLeaderboard();if(view==="profile")renderProfile();if(view==="admin")renderAdmin()}
$$("[data-view]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.view)));

function openAuth(mode="login"){ $("#authModal").classList.remove("hidden");showAuth(mode)}
function closeAuth(){$("#authModal").classList.add("hidden")}
function showAuth(mode){
 $("#userAuth").innerHTML = mode==="login" ? `
  <h2>Welcome back</h2><input id="u" placeholder="Username" required><input id="p" type="password" placeholder="Password" required><button class="primary">Login</button>
  <p class="hint">No account? Use Register above.</p>` : `
  <h2>Create account</h2><input id="n" placeholder="Your name" required><input id="u" placeholder="Username" required><input id="p" type="password" placeholder="Password (4+ characters)" required><button class="primary">Create account</button>`;
 $("#userAuth").onsubmit=async e=>{e.preventDefault();try{
   const body=mode==="login"?{username:$("#u").value,password:$("#p").value}:{name:$("#n").value,username:$("#u").value,password:$("#p").value};
   const data=await api(mode==="login"?"/api/login":"/api/register",{method:"POST",body:JSON.stringify(body)});
   if(mode==="login"){currentUser=data;localStorage.setItem("bslUser",JSON.stringify(data));toast("Welcome back!")}
   else {toast("Account created. Now log in.");showAuth("login");return}
   closeAuth();renderProfile();
 }catch(err){toast(err.message)}}
}
function requireLogin(){if(!currentUser){openAuth("login");return false}return true}

async function loadMatches(){
 const matches=await api("/api/matches");$("#matchCount").textContent=matches.length;
 const grid=$("#matchesGrid");
 if(!matches.length){grid.innerHTML='<div class="panel"><h3>No matches yet</h3><p class="hint">The admin will publish fixtures here.</p></div>';return}
 grid.innerHTML=matches.map(m=>matchHTML(m)).join("");
}
function matchHTML(m){
 const closed=!m.canPredict;
 return `<article class="matchCard" data-match="${m.id}">
  <div class="matchMeta"><span>MD${m.matchday} · ${new Date(m.match_time).toLocaleString()}</span><span>${m.status==="settled"?"SETTLED":closed?"CLOSED":"OPEN"}</span></div>
  <div class="teams"><b>${esc(m.home_team)}</b><span class="vs">VS</span><b>${esc(m.away_team)}</b></div>
  ${m.status==="settled"?`<div class="panel" style="padding:12px;text-align:center"><b>Final: ${m.home_score} - ${m.away_score}</b></div>`:
  !currentUser?`<button class="primary saveBtn" onclick="openAuth('login')">Login to predict</button>`:
  closed?`<p class="deadline">Prediction deadline has passed.</p>`:
  `<div class="points">
    <button data-out="home" onclick="choose(this)">Home win<br><b>${m.home_points} pts</b></button>
    <button data-out="draw" onclick="choose(this)">Draw<br><b>${m.draw_points} pts</b></button>
    <button data-out="away" onclick="choose(this)">Away win<br><b>${m.away_points} pts</b></button>
  </div>
  <div class="scoreRow"><span>Exact score:</span><input class="hs" type="number" min="0" placeholder="${m.home_team}"><b>-</b><input class="as" type="number" min="0" placeholder="${m.away_team}"></div>
  <button class="primary saveBtn" onclick="savePrediction(${m.id})">Save prediction</button>
  <div class="deadline">Deadline: ${new Date(m.deadline).toLocaleString()} • Exact score bonus +6</div>`}
 </article>`
}
function choose(btn){btn.parentElement.querySelectorAll("button").forEach(x=>x.classList.remove("selected"));btn.classList.add("selected")}
async function savePrediction(id){
 if(!requireLogin())return;
 const card=document.querySelector(`[data-match="${id}"]`), selected=card.querySelector(".selected");
 if(!selected)return toast("Choose Home win, Draw or Away win.");
 const hs=Number(card.querySelector(".hs").value),as=Number(card.querySelector(".as").value);
 if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0)return toast("Enter the predicted score.");
 try{await api("/api/predictions",{method:"POST",body:JSON.stringify({userId:currentUser.id,matchId:id,outcome:selected.dataset.out,homeScore:hs,awayScore:as})});toast("Prediction saved!")}catch(e){toast(e.message)}
}
async function loadLeaderboard(){
 const rows=await api("/api/leaderboard");
 const {currentMatchday}=await api("/api/matchday");
 const heading=document.querySelector("#leaderboard h2");
 if(heading)heading.textContent=`Leaderboard — Match Day ${currentMatchday}`;
 $("#leaderBody").innerHTML=rows.length?rows.map(r=>`<tr><td class="${r.rank===1?'rank1':''}">#${r.rank}</td><td><b>${esc(r.name)}</b></td><td>${esc(r.username)}</td><td><b>${r.points}</b></td></tr>`).join(""):`<tr><td colspan="4">No players yet.</td></tr>`;
}
async function renderProfile(){
 const box=$("#profileBox");
 if(!currentUser){box.innerHTML='<div class="panel"><h3>You are not logged in.</h3><button class="primary" onclick="openAuth()">Login / Register</button></div>';return}
 const leaders=await api("/api/leaderboard"), me=leaders.find(x=>x.id===currentUser.id);
 const preds=await api(`/api/user/${currentUser.id}/predictions`);
 box.innerHTML=`<div class="panel"><p class="eyebrow">PLAYER</p><h2>${esc(currentUser.name)}</h2><p class="hint">@${esc(currentUser.username)}</p><div class="stats"><div><b>${me?.points||0}</b><span>This match day</span></div><div><b>#${me?.rank||"-"}</b><span>Current rank</span></div><div><b>${preds.length}</b><span>Predictions</span></div></div><button class="secondary" style="margin-top:15px" onclick="logout()">Log out</button></div>
 <div class="panel" style="margin-top:16px"><h3>Prediction history</h3>${preds.length?preds.map(p=>`<div class="userLine"><b>${esc(p.home_team)} ${p.home_score??"-"} - ${p.away_score??"-"} ${esc(p.away_team)}</b><br><span class="hint">Your pick: ${p.outcome} • ${p.points_awarded} pts • ${p.status}</span></div>`).join(""):"<p class='hint'>No predictions yet.</p>"}</div>`;
}
function logout(){currentUser=null;localStorage.removeItem("bslUser");renderProfile();go("home");toast("Logged out")}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

$("#adminLogin").onsubmit=async e=>{e.preventDefault();try{const d=await api("/api/admin/login",{method:"POST",body:JSON.stringify({username:$("#adminUser").value,password:$("#adminPass").value})});adminToken=d.token;localStorage.setItem("bslAdminToken",adminToken);renderAdmin();toast("Admin logged in")}catch(e){toast(e.message)}}
function adminLogout(){adminToken=null;localStorage.removeItem("bslAdminToken");renderAdmin()}
async function renderAdmin(){
 if(!adminToken){$("#adminLoginBox").classList.remove("hidden");$("#adminPanel").classList.add("hidden");return}
 $("#adminLoginBox").classList.add("hidden");$("#adminPanel").classList.remove("hidden");
 try{await loadAdminUsers();await loadAdminMatches();await loadMatchdayLabel()}catch(e){adminLogout();toast(e.message)}
}
async function loadMatchdayLabel(){
 const {currentMatchday}=await api("/api/matchday");
 $("#currentMatchdayLabel").textContent=currentMatchday;
}
async function advanceMatchday(){
 if(!confirm("Start a new match day? The leaderboard will reset to zero for everyone on the new match day. Past match days and results are kept, they just won't count on the leaderboard anymore."))return;
 try{
  const d=await adminApi("/api/admin/matchday/advance",{method:"POST"});
  $("#currentMatchdayLabel").textContent=d.currentMatchday;
  toast(`Now on Match Day ${d.currentMatchday}`);
  loadLeaderboard();
 }catch(e){toast(e.message)}
}
async function adminApi(url,opts={}){return api(url,{...opts,headers:{Authorization:`Bearer ${adminToken}`,...(opts.headers||{})}})}
async function loadAdminUsers(){const rows=await adminApi("/api/admin/users");$("#adminUsers").innerHTML=rows.length?rows.map(u=>`<div class="userLine"><b>${esc(u.name)}</b> <span class="hint">@${esc(u.username)}</span><br><b>${u.points} pts</b></div>`).join(""):"<p class='hint'>No registered users.</p>"}
async function loadAdminMatches(){
 const ms=await adminApi("/api/admin/matches");
 $("#adminMatches").innerHTML=ms.length?ms.map(m=>`<div class="adminMatch"><div><b>${esc(m.home_team)} vs ${esc(m.away_team)}</b><br><span class="hint">${new Date(m.match_time).toLocaleString()} • Deadline ${new Date(m.deadline).toLocaleString()} • ${m.home_points}/${m.draw_points}/${m.away_points} pts</span></div><div class="adminActions">${m.status!=="settled"?`<button class="secondary" onclick="setResult(${m.id},'${esc(m.home_team)}','${esc(m.away_team)}')">Result</button>`:""}${m.status==="open"?`<button class="secondary" onclick="closeMatch(${m.id})">Close</button>`:""}</div></div>`).join(""):"<p class='hint'>No matches created.</p>"
}
$("#matchForm").onsubmit=async e=>{e.preventDefault();try{await adminApi("/api/admin/matches",{method:"POST",body:JSON.stringify({homeTeam:$("#homeTeam").value,awayTeam:$("#awayTeam").value,matchTime:$("#matchTime").value,deadline:$("#deadline").value,homePoints:Number($("#homePoints").value),drawPoints:Number($("#drawPoints").value),awayPoints:Number($("#awayPoints").value)})});e.target.reset();$("#homePoints").value=3;$("#drawPoints").value=4;$("#awayPoints").value=6;toast("Match published!");loadAdminMatches();loadMatches()}catch(e){toast(e.message)}}
async function setResult(id,h,a){const hs=prompt(`Final score for ${h}`),as=prompt(`Final score for ${a}`);if(hs===null||as===null)return;try{await adminApi(`/api/admin/matches/${id}/result`,{method:"POST",body:JSON.stringify({homeScore:Number(hs),awayScore:Number(as)})});toast("Result saved and points awarded.");loadAdminMatches();loadLeaderboard();loadMatches()}catch(e){toast(e.message)}}
async function closeMatch(id){if(!confirm("Close predictions for this match?"))return;try{await adminApi(`/api/admin/matches/${id}/close`,{method:"POST"});toast("Predictions closed.");loadAdminMatches();loadMatches()}catch(e){toast(e.message)}}

renderAdmin();loadMatches();loadLeaderboard();renderProfile();
