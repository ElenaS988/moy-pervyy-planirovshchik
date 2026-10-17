/* Деньги по плану. Локальный учет, планирование и цели. */
(() => {
  'use strict';
  const APP = 'moneyByPlan', DB_VERSION = 1;
  const STORES = ['family','users','currencies','wallets','categories','rates','operations','postings','expenseLines','proposals','plans','planLinks','series','limits','goals','reserveEvents','deposits','depositEvents','loans','loanSchedules','loanEvents','personalDebts','debtEvents','audit','meta'];
  const ROLE = {owner:'Владелец',editor:'Участник',contributor:'С подтверждением',viewer:'Наблюдатель'};
  const TYPE = {income:'Доход',expense:'Расход',refund:'Возврат',transfer:'Перевод',fx:'Обмен валют'};
  const MANUAL_TYPES=Object.keys(TYPE);
  Object.assign(TYPE,{deposit_open:'Открытие вклада',deposit_topup:'Пополнение вклада',deposit_withdraw:'Снятие со вклада',deposit_interest:'Проценты по вкладу',deposit_capitalization:'Капитализация',deposit_close:'Закрытие вклада',credit_received:'Получение кредита',credit_payment:'Платеж по кредиту',credit_early:'Досрочное погашение',debt_issue:'Выдача займа',debt_receive:'Получение займа',debt_return:'Возврат займа'});
  const WALLET = {card:'Банковская карта',bank_account:'Банковский счет',cash:'Наличные',crypto:'Криптокошелек'};
  const PALETTE = ['#527462','#b47b64','#7e8c9b','#b09b64','#99849a','#7b9a95'];
  let db, data, session = null, view = 'overview', settingsTab = 'general', operationTab = 'posted', limit = 50;
  let filters = {}, modal = null, lastActivity = Date.now(), channel, toastTimer;
  const passwordProofs = new Map();
  let planningTab='plans', planningMonth='', planningKind='all', forecastDate='', reconciling=false;
  const id = () => crypto.randomUUID(), now = () => new Date().toISOString();
  const clone = x => structuredClone(x);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key,value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') node.value = value;
      else if (key === 'checked') node.checked = value;
      else node.setAttribute(key,value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  };
  const button = (text,fn,cls='',attrs={}) => el('button',{type:'button',class:cls,onClick:fn,...attrs},text);
  const get = (s,store,key) => s[store].find(x=>x.id===key);
  const family = s => s.family[0];
  const user = () => session && get(data,'users',session.id);
  const owner = () => user()?.role === 'owner';
  const writer = () => ['owner','editor'].includes(user()?.role);
  const canSubmit = () => user() && user().role !== 'viewer';
  const active = s => s.operations.filter(x=>x.status==='posted');
  const dateIn = (zone='Europe/Moscow', date=new Date()) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const today = s => dateIn(family(s)?.timezone || 'Europe/Moscow');
  const timeIn = s => new Intl.DateTimeFormat('ru-RU',{timeZone:family(s).timezone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
  const validDate = x => /^\d{4}-\d{2}-\d{2}$/.test(x || '') && !Number.isNaN(Date.parse(x+'T12:00:00Z')) && new Date(x+'T12:00:00Z').toISOString().slice(0,10)===x && x>='1900-01-01' && x<='2200-12-31';
  const dayNumber = x => Date.parse(x+'T12:00:00Z') / 86400000;
  class AppError extends Error { constructor(message,field='',code='VALIDATION'){super(message);this.field=field;this.code=code;} }
  const requireThat = (ok,message,field='',code='VALIDATION') => {if(!ok) throw new AppError(message,field,code);};
  const p10 = n => 10n ** BigInt(n);
  const rounded = (a,b) => { const sign=a<0n?-1n:1n; a=a<0n?-a:a; return sign*((a+b/2n)/b); };
  function parseMoney(value,decimals,zero=false) {
    const text=String(value??'').trim().replace(/[\s\u00a0\u202f]/g,'');
    requireThat(/^\d+(?:[.,]\d+)?$/.test(text),'Введите сумму цифрами, например 1 250,50.');
    const [whole,tail='']=text.replace(',','.').split('.');
    requireThat(tail.length<=decimals,`Для этой валюты допустимо ${decimals} знаков после запятой.`);
    requireThat(whole.length<=24,'Сумма слишком велика.');
    const result=BigInt(whole)*p10(decimals)+BigInt((tail+'0'.repeat(decimals)).slice(0,decimals)||'0');
    requireThat(zero || result>0n,'Сумма должна быть больше нуля.'); return result;
  }
  function plain(amount,decimals) {
    let value=BigInt(amount), sign=value<0n?'-':''; if(value<0n)value=-value;
    return sign+(value/p10(decimals)).toString()+(decimals?'.'+(value%p10(decimals)).toString().padStart(decimals,'0'):'');
  }
  function money(amount,code='RUB',s=data) {
    if(amount===null || amount===undefined)return 'Нет курса';
    const decimals=get(s,'currencies',code)?.decimals ?? 2;
    const negative=BigInt(amount)<0n,text=plain(negative?-BigInt(amount):amount,decimals), [whole,tail]=text.split('.');
    const grouped=(negative?'−':'')+BigInt(whole).toLocaleString('ru-RU');
    let fraction=tail ? tail.replace(/0+$/,'') : ''; if(decimals===2)fraction=(tail||'00');
    return `${grouped}${fraction?','+fraction:''} ${code==='RUB'?'₽':code}`;
  }
  const amountOf = (value,code,s=data,zero=false) => parseMoney(value,get(s,'currencies',code).decimals,zero);
  const rateAt = (s,code,date) => code==='RUB'?'1':s.rates.filter(x=>x.currency===code && x.effectiveDate<=date).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate)||b.enteredAt.localeCompare(a.enteredAt))[0]?.rubPerUnit ?? null;
  function inRub(s,amount,code,date,rateOverride) {
    const rate=rateOverride===undefined?rateAt(s,code,date):rateOverride;
    if(rate===null)return null;
    return rounded(BigInt(amount)*parseMoney(rate,12)*100n,p10(get(s,'currencies',code).decimals)*p10(12));
  }
  function balances(s,until=today(s)) {
    const result=Object.fromEntries(s.wallets.map(w=>[w.id,family(s).startDate<=until?BigInt(w.openingBalance):0n]));
    const ids=new Set(active(s).filter(o=>o.effectiveDate<=until).map(o=>o.id));
    for(const p of s.postings)if(ids.has(p.operationId)&&p.accountType==='wallet')result[p.accountId]=(result[p.accountId]||0n)+BigInt(p.signedAmount);
    return result;
  }
  function total(s,liquid=false,includeDeposits=true) {
    const sums=balances(s); let known=0n;const missing=[];
    for(const w of s.wallets)if(!liquid||w.liquid){const amount=sums[w.id]||0n;if(!amount)continue;const rub=inRub(s,amount,w.currency,today(s));if(rub===null)missing.push({currency:w.currency,amount});else known+=rub;}
    if(!liquid&&includeDeposits)for(const d of s.deposits){const amount=depositBalance(s,d);if(!amount)continue;const rub=inRub(s,amount,d.currency,today(s));if(rub===null)missing.push({currency:d.currency,amount});else known+=rub;}
    return {known,missing};
  }
  function statistics(s,from='',to=today(s)) {
    let income=0n,expense=0n,bankFees=0n,otherFees=0n,missing=false;
    for(const o of active(s).filter(o=>o.effectiveDate>=from&&o.effectiveDate<=to)) {
      if(o.businessType==='income'){if(o.rubSnapshot===null)missing=true;else income+=BigInt(o.rubSnapshot);}
      for(const c of o.incomeComponents||[]){if(c.rubSnapshot===null)missing=true;else income+=BigInt(c.rubSnapshot);}
      for(const line of s.expenseLines.filter(l=>l.operationId===o.id)) {
        if(line.rubSnapshot===null){missing=true;continue;}
        const a=BigInt(line.rubSnapshot);expense+=a;
        const cat=get(s,'categories',line.categoryId);if(cat?.systemCode==='bank_fees')bankFees+=a;if(cat?.systemCode==='other_fees')otherFees+=a;
      }
    }
    return {income,expense,bankFees,otherFees,missing};
  }

  /* Planning and goals: integer amounts, calendar dates, no writes from calculations. */
  const monthEnd = date => {const [y,m]=date.split('-').map(Number);return new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10);};
  function monthlyDate(month,day){return month+'-'+String(Math.min(Number(day),Number(monthEnd(month+'-01').slice(8)))).padStart(2,'0');}
  function nextMonth(month,n=1){const [y,m]=month.split('-').map(Number),d=new Date(Date.UTC(y,m-1+n,1,12));return d.toISOString().slice(0,7);}
  function convert(s,amount,from,to,date=today(s)){
    if(from===to)return BigInt(amount);const a=rateAt(s,from,date),b=rateAt(s,to,date);if(a===null||b===null)return null;
    return rounded(BigInt(amount)*parseMoney(a,12)*p10(get(s,'currencies',to).decimals),parseMoney(b,12)*p10(get(s,'currencies',from).decimals));
  }
  function reserveBalances(s,until=today(s)){
    const ops=new Set(active(s).map(o=>o.id)),out={};
    for(const e of s.reserveEvents)if(e.effectiveDate<=until&&(!e.operationId||ops.has(e.operationId))){const key=e.goalId+'|'+e.walletId;out[key]=(out[key]||0n)+BigInt(e.signedAmount);}
    return out;
  }
  const reservedOn = (s,walletId,until=today(s)) => Object.entries(reserveBalances(s,until)).filter(([k])=>k.split('|')[1]===walletId).reduce((n,[,a])=>n+a,0n);
  function reserveEvent(s,goalId,walletId,amount,date,operationId=null,counts=true,extra={}){s.reserveEvents.push(stamp({id:id(),goalId,walletId,effectiveDate:date,signedAmount:amount.toString(),operationId,countsForMonthlyPlan:counts,...extra},session.id));}
  function planState(s,p){
    const ids=new Set(active(s).map(o=>o.id)),links=s.planLinks.filter(l=>l.planId===p.id&&l.status==='active'&&ids.has(l.operationId));
    const paid=links.reduce((n,l)=>n+BigInt(l.appliedAmountInPlanCurrency),0n),final=links.some(l=>l.finalize),closed=['skipped','cancelled'].includes(p.status);
    const remaining=closed||final?0n:BigInt(p.amount)>paid?BigInt(p.amount)-paid:0n;
    return {paid,remaining,excess:paid>BigInt(p.amount)?paid-BigInt(p.amount):0n,status:closed?p.status:!remaining?'fulfilled':paid?'partially_fulfilled':'planned',links};
  }
  function coverageLeft(s,p){const st=planState(s,p);if(!st.remaining||!p.reserveCoverage)return 0n;const spent=st.links.reduce((n,l)=>n+BigInt(l.coveredAmount||0),0n),left=BigInt(p.reserveCoverage.amount)-spent;return left>0n?(left<st.remaining?left:st.remaining):0n;}
  function syncPlans(s){for(const p of s.plans){const st=planState(s,p);p.status=st.status;p.finalizedAt=st.links.find(l=>l.finalize)?.createdAt||null;p.finalizationReason=p.finalizedAt?'Фактическая стоимость меньше ожидания':null;}}
  function validateReserves(s){
    const dates=[...new Set([today(s),...s.reserveEvents.map(e=>e.effectiveDate),...active(s).map(o=>o.effectiveDate)])].sort();
    for(const date of dates){const r=reserveBalances(s,date),b=balances(s,date);for(const [key,amount] of Object.entries(r))requireThat(amount>=0n,'Сначала исправьте зависимое освобождение или перенос резерва.');for(const w of s.wallets){const sum=Object.entries(r).filter(([k])=>k.split('|')[1]===w.id).reduce((n,[,a])=>n+a,0n);requireThat(sum===0n||sum<=(b[w.id]>0n?b[w.id]:0n),`На счете «${w.name}» затронут резерв цели. Укажите цель и освободите резерв; при отмене сначала исправьте зависимые действия.`,'reserveGoalId');}}
    const covered=new Set(),r=reserveBalances(s);
    for(const p of s.plans){const amount=coverageLeft(s,p);if(!amount)continue;const c=p.reserveCoverage,key=c.goalId+'|'+c.walletId;requireThat(!covered.has(key),'Этот резерв уже покрывает другой план.');covered.add(key);requireThat(amount<=(r[key]||0n),'Покрытие плана больше оставшегося резерва. Сначала измените покрытие плана.');}
  }
  function goalInfo(s,g,date=today(s)){
    let saved=0n,missing=false,net=0n;const reserves=reserveBalances(s,date);
    for(const [key,a] of Object.entries(reserves))if(key.split('|')[0]===g.id&&a){const w=get(s,'wallets',key.split('|')[1]),v=convert(s,a,w.currency,g.currency,date);if(v===null)missing=true;else saved+=v;}
    const activeIds=new Set(active(s).map(o=>o.id));for(const e of s.reserveEvents)if(e.goalId===g.id&&e.countsForMonthlyPlan&&e.effectiveDate.slice(0,7)===date.slice(0,7)&&e.effectiveDate<=date&&(!e.operationId||activeIds.has(e.operationId))){const w=get(s,'wallets',e.walletId),v=convert(s,e.signedAmount,w.currency,g.currency,date);if(v===null)missing=true;else net+=v;}
    const remaining=BigInt(g.target)>saved?BigInt(g.target)-saved:0n,expected=BigInt(family(s).expectedMonthlyIncome||0);let monthly=0n,count=0,last=0n,finish=null,oneOff=false;
    const first=g.firstDate>date?g.firstDate:date;let month=first.slice(0,7),firstDue=monthlyDate(month,g.contributionDay);if(firstDue<first)firstDue=monthlyDate(nextMonth(month),g.contributionDay);
    if(g.mode==='date'){
      let d=firstDue;while(d<=g.dueDate&&count<3613){count++;finish=d;d=monthlyDate(nextMonth(d.slice(0,7)),g.contributionDay);}
      if(count){monthly=(remaining+BigInt(count)-1n)/BigInt(count);if(monthly&&remaining){count=Number((remaining+monthly-1n)/monthly);last=remaining-monthly*BigInt(count-1);finish=monthlyDate(nextMonth(firstDue.slice(0,7),count-1),g.contributionDay);}}else{oneOff=remaining>0n;monthly=remaining;}
    }else{
      if(g.contributionType==='percent'){
        if(expected){const rub=rounded(expected*parseMoney(g.contributionPercent||'0',4,true),100n*p10(4)),v=convert(s,rub,'RUB',g.currency,date);if(v===null)missing=true;else monthly=v;}
      }else monthly=BigInt(g.contributionAmount||0);
      if(monthly&&remaining){const n=(remaining+monthly-1n)/monthly;count=n>100000n?100001:Number(n);last=remaining-monthly*(n-1n);if(count<=3613){const d=monthlyDate(nextMonth(firstDue.slice(0,7),count-1),g.contributionDay);if(validDate(d))finish=d;}}
    }
    if(!remaining){monthly=0n;count=0;finish=date;last=0n;}
    let monthPlan=monthly;
    if(g.mode==='pace'){const outstanding=remaining+(net>0n?net:0n);if(monthPlan>outstanding)monthPlan=outstanding;}
    if(g.mode==='date'&&remaining){
      // Include a contribution already made this month when deriving this month's requirement.
      let n=0,d=monthlyDate(date.slice(0,7),g.contributionDay);if(d<g.firstDate)d=firstDue;
      while(d<=g.dueDate&&n<3613){n++;d=monthlyDate(nextMonth(d.slice(0,7)),g.contributionDay);}
      const base=remaining+(net>0n?net:0n);monthPlan=n?(base+BigInt(n)-1n)/BigInt(n):remaining+(net>0n?net:0n);
    }
    const eligible=g.status==='active'&&g.firstDate<=monthEnd(date),left=eligible&&monthPlan>0n&&monthPlan>net?monthPlan-net:0n;
    const rub=convert(s,monthly,g.currency,'RUB',date),percent=expected&&rub!==null?Number(rounded(rub*10000n,expected))/100:null;
    const days=g.mode==='date'&&g.dueDate>=date?BigInt(dayNumber(g.dueDate)-dayNumber(date)+1):0n;
    return {saved,remaining,monthly,count,last,finish,missing,net,monthPlan,left,percent,oneOff,overdue:g.mode==='date'&&g.dueDate<date&&remaining>0n,daily:days?rounded(remaining,days):0n,weekly:days?rounded(remaining*7n,days):0n};
  }
  function budgetInfo(s,until=monthEnd(today(s))){
    s=clone(s);materialize(s,until);syncContractPlans(s); // Read-only forecast can extend the horizon for any role.
    const liquid=total(s,true),all=total(s),date=today(s);let R=0n,O=0n,G=0n,E=0n,income=0n,outgoing=0n,missing=liquid.missing.length>0,overdueIncome=false;
    for(const [key,a] of Object.entries(reserveBalances(s)))if(a){const w=get(s,'wallets',key.split('|')[1]);if(w.liquid){const v=inRub(s,a,w.currency,date);if(v===null)missing=true;else R+=v;}}
    for(const p of s.plans){const st=planState(s,p);if(!st.remaining||p.date>until)continue;const value=inRub(s,st.remaining,p.currency,date);if(value===null){missing=true;continue;}
      if(p.kind==='expense'){outgoing+=value;const uncovered=st.remaining-coverageLeft(s,p),v=inRub(s,uncovered,p.currency,date);O+=v??0n;}
      else{income+=value;if(p.date<date)overdueIncome=true;if(get(s,'wallets',p.walletId)?.liquid)E+=value;}
    }
    for(const g of s.goals.filter(g=>g.status==='active')){const i=goalInfo(s,g);missing||=i.missing;const v=inRub(s,i.left,g.currency,date);if(v===null&&i.left)missing=true;else G+=v||0n;}
    return {L:liquid.known,R,O,G,E,A:liquid.known-R-O-G,free:liquid.known-R,B:all.known,forecast:total(s,false,false).known+income-outgoing,income,outgoing,missing:missing||all.missing.length>0,overdueIncome};
  }
  function materialize(s,until){
    for(const series of s.series.filter(x=>x.status==='active')){let month=series.start.slice(0,7);while(month<=until.slice(0,7)){
      const date=monthlyDate(month,series.monthlyDay),key=series.id+':'+month;
      if(date>=series.start&&(!series.end||date<=series.end)&&!s.plans.some(p=>p.occurrenceKey===key))s.plans.push(stamp({id:id(),...clone(series.template),date,seriesId:series.id,occurrenceKey:key,status:'planned',reserveCoverage:null,finalizedAt:null,finalizationReason:null},series.createdBy));month=nextMonth(month);
    }}
  }
  function planLink(s,p,o,old){
    const prior=old?s.planLinks.find(l=>l.operationId===old.id&&l.status==='active'):null;
    if(prior)prior.status='reversed';const key=p.planId===undefined?prior?.planId:p.planId;if(!key)return;
    const plan=get(s,'plans',key);requireThat(plan&&!['cancelled','skipped'].includes(plan.status),'Выберите открытый план.','planId');requireThat(!plan.module,'Договорный платеж проводится только из соответствующего договора.');
    requireThat(o.businessType===plan.kind&&o.currency===plan.currency,'Тип и валюта исполнения должны совпадать с планом.','planId');
    const before=planState(s,plan);requireThat(before.remaining>0n,'План уже исполнен.','planId');const applied=BigInt(o.amount),covered=plan.kind==='expense'?(coverageLeft(s,plan)<applied?coverageLeft(s,plan):applied):0n;
    if(covered){const c=plan.reserveCoverage;requireThat(o.walletId===c.walletId,'Для оплаты из резерва выберите кошелек покрытия плана.','walletId');reserveEvent(s,c.goalId,c.walletId,-covered,o.effectiveDate,o.id,true,{coveragePlanId:plan.id});}
    s.planLinks.push(stamp({id:id(),planId:key,operationId:o.id,appliedAmountInPlanCurrency:o.amount,coveredAmount:covered.toString(),finalize:p.planFinalize===undefined?!!prior?.finalize:!!p.planFinalize,status:'active'},o.actorId));o.links.planId=key;
  }
  function operationReserves(s,p,o,old){
    if(old&&p.reserveActions===undefined&&p.reserveGoalId===undefined){
      const previous=s.reserveEvents.filter(e=>e.operationId===old.id&&!e.coveragePlanId);requireThat(!previous.length,'При исправлении заново укажите перенос или освобождение резерва.','reserveGoalId');
    }
    const actions=p.reserveActions||(p.reserveGoalId&&p.reserveAmount?[{goalId:p.reserveGoalId,amount:p.reserveAmount}]:[]),source=get(s,'wallets',o.walletId),released={},moved={};
    for(const a of actions){const g=get(s,'goals',a.goalId);requireThat(g&&g.status!=='archived','Выберите действующую цель.','reserveGoalId');const walletId=a.walletId||source.id,w=walletActive(s,walletId),amount=amountOf(a.amount,w.currency,s);const key=g.id+'|'+w.id;
      requireThat(amount<=(reserveBalances(s,o.effectiveDate)[key]||0n),'Сумма больше резерва выбранной цели.','reserveAmount');
      const outgoing=-s.postings.filter(post=>post.operationId===o.id&&post.accountId===w.id&&BigInt(post.signedAmount)<0n).reduce((n,post)=>n+BigInt(post.signedAmount),0n),covered=s.reserveEvents.filter(e=>e.operationId===o.id&&e.coveragePlanId&&e.walletId===w.id).reduce((n,e)=>n-BigInt(e.signedAmount),0n);released[w.id]=(released[w.id]||0n)+amount;requireThat(outgoing>0n&&released[w.id]+covered<=outgoing,'Освобождение не может превышать списание с этого кошелька.','reserveAmount');
      const tx=['transfer','fx'].includes(o.businessType),move=tx&&w.id===source.id&&!a.release;
      if(tx&&!move)requireThat(o.fee?.walletId===w.id&&released[w.id]-(moved[w.id]||0n)<=BigInt(o.fee.amount),'Отдельное освобождение при переводе возможно только для его комиссии.');
      reserveEvent(s,g.id,w.id,-amount,o.effectiveDate,o.id,!move,{releaseOnly:!move});
      if(move){moved[w.id]=(moved[w.id]||0n)+amount;requireThat(moved[w.id]<=BigInt(o.amount),'Перенос больше суммы перевода.');const received=rounded(amount*BigInt(o.receivedAmount),BigInt(o.amount));requireThat(received>0n,'Перенос меньше точности валюты.');reserveEvent(s,g.id,o.targetId,received,o.effectiveDate,o.id,false);}
    }
  }
  /* Contracts: fixed-point arithmetic, dated event registers and dedicated ledger groups. */
  const FP=10n**24n, RATE_SCALE=1000000n;
  const addDays=(date,n=1)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  const rateUnits=value=>{const n=parseMoney(value,6,true);requireThat(n<=1000n*RATE_SCALE,'Годовая ставка от 0 до 1000%.','annualRate');return n;};
  function contractEvents(s,store,key){const ops=new Set(active(s).map(o=>o.id));return s[store].filter(e=>e.contractId===key&&e.operationId&&ops.has(e.operationId)).sort((a,b)=>a.date.localeCompare(b.date)||a.sequence-b.sequence);}
  function depositBalance(s,d,until=today(s)){
    if(d.status==='cancelled'||family(s).startDate>until)return 0n;let amount=BigInt(d.initialPrincipal||0);const ops=new Set(active(s).filter(o=>o.effectiveDate<=until).map(o=>o.id));for(const p of s.postings)if(p.accountType==='deposit'&&p.accountId===d.id&&ops.has(p.operationId))amount+=BigInt(p.signedAmount);return amount;
  }
  function depositDates(s,d){const out=[];if(d.payoutMode==='monthly'){let m=d.openingDate.slice(0,7);while(m<=d.endDate.slice(0,7)){const date=monthlyDate(m,d.payoutDay);if(date>d.openingDate&&date>=family(s).startDate&&date<d.endDate)out.push(date);m=nextMonth(m);}}out.push(d.endDate);return [...new Set(out)];}
  function depositRate(d,date){return [...d.rateIntervals].filter(r=>r.date<=date).sort((a,b)=>b.date.localeCompare(a.date))[0]?.rate||'0';}
  function depositProjection(s,d,until=d.endDate,options={}){
    let principal=BigInt(d.initialPrincipal||0),bucket=BigInt(d.initialUnpaidInterest||0)*FP,totalAccrued=0n,recognized=0n,paid=0n,capitalized=0n,initialLeft=BigInt(d.initialUnpaidInterest||0),closed=false,allocated=0n,expectedIncome=0n;const rows=[];
    const events=contractEvents(s,'depositEvents',d.id).filter(e=>e.date<=until),byDate=new Map(),due=new Set(depositDates(s,d));
    for(const e of events){if(!byDate.has(e.date))byDate.set(e.date,[]);byDate.get(e.date).push(e);}
    const first=d.mode==='existing'?family(s).startDate:addDays(d.openingDate),start=d.mode==='existing'?family(s).startDate:d.openingDate;
    const last=until<d.endDate?until:d.endDate;
    for(let date=start;date<=last&&!closed;date=addDays(date)){
      if(date>=first){const year=Number(date.slice(0,4)),days=year%4===0&&(year%100!==0||year%400===0)?366n:365n,rate=rateUnits(options.early?d.earlyRate:depositRate(d,date)),interest=principal*rate*FP/(100n*RATE_SCALE*days);bucket+=interest;totalAccrued+=interest;}
      const dayEvents=byDate.get(date)||[];let settled=false;
      for(const e of dayEvents){
        if(['interest','capitalization'].includes(e.type)){const amount=options.early?rounded(bucket,FP):BigInt(e.actualAmount);recognized+=amount;if(e.type==='capitalization'){principal+=amount;capitalized+=amount;}else paid+=amount;bucket=0n;allocated=0n;initialLeft=0n;settled=true;}
        else if(e.type==='close'){if(!options.early)recognized+=BigInt(e.actualAmount||0);principal=0n;bucket=0n;closed=true;settled=true;}
        else principal+=BigInt(e.principalDelta||0);
      }
      if(due.has(date)&&!settled&&!closed){const full=rounded(bucket,FP),capitalization=d.capitalizes&&date!==d.endDate,amount=d.capitalizes&&(date===d.endDate||options.future&&date>today(s))?full:full-allocated;rows.push({date,amount,closing:date===d.endDate,principal});if(!capitalization||options.future&&date>today(s))expectedIncome+=amount;allocated=full;if(options.future&&date>today(s)){if(capitalization)principal+=amount;bucket=0n;allocated=0n;initialLeft=0n;}}
    }
    return {principal,accrued:rounded(bucket,FP),calculated:rounded(totalAccrued,FP),recognized,paid,capitalized,initialLeft,rows,closed,projectedIncome:recognized+expectedIncome};
  }
  function depositEarly(s,d,date){
    const shadow=depositProjection(s,d,date,{early:true}),events=contractEvents(s,'depositEvents',d.id),paid=events.filter(e=>e.type==='interest'&&e.date<=date).reduce((n,e)=>n+BigInt(e.actualAmount),0n),cap=events.filter(e=>e.type==='capitalization'&&e.date<=date).reduce((n,e)=>n+BigInt(e.actualAmount),0n),allowed=shadow.paid+shadow.capitalized+shadow.accrued-(d.mode==='existing'?BigInt(d.initialUnpaidInterest||0):0n),principal=depositBalance(s,d,date),adjustment=allowed-paid-cap;
    return {principal,allowed,paid,capitalized:cap,adjustment,returnAmount:principal+adjustment,unknownHistory:d.mode==='existing'};
  }
  function loanSchedule(P,annualRate,months,firstDate,day,model='annuity',fixedPayment=null,fixedBody=null,dates=null){
    P=BigInt(P);requireThat(Number.isInteger(months)&&months>=1&&months<=600,'Срок от 1 до 600 месяцев.','months');const r=rateUnits(annualRate),denominator=1200n*RATE_SCALE;let installment;
    // Exact rational powers avoid precision loss for very large amounts or tiny rates.
    if(fixedPayment!==null)installment=BigInt(fixedPayment);else if(!r)installment=rounded(P,BigInt(months));else{const power=(denominator+r)**BigInt(months),base=denominator**BigInt(months);installment=rounded(P*r*power,denominator*(power-base));}
    const body=fixedBody===null?rounded(P,BigInt(months)):BigInt(fixedBody),rows=[];let balance=P;
    for(let i=0;i<months&&balance>0n;i++){const interest=rounded(balance*r,denominator);let principal=model==='differentiated'?body:installment-interest;if(i===months-1&&fixedPayment===null&&fixedBody===null)principal=balance;principal=principal>balance?balance:principal;requireThat(principal>0n||installment===0n&&i<months-1,'Платеж не покрывает проценты. Увеличьте сумму или срок.');
      const date=dates?.[i]|| (i===0?firstDate:monthlyDate(nextMonth(firstDate.slice(0,7),i),day));requireThat(validDate(date),'График вышел за поддерживаемые даты.');balance-=principal;rows.push({date,principal,interest,balance,payment:principal+interest});}
    requireThat(balance===0n,'Новый срок не позволяет погасить долг.','months');return rows;
  }
  function loanState(s,l){const events=contractEvents(s,'loanEvents',l.id);let principal=['cancelled','planned'].includes(l.status)?0n:BigInt(l.principalAtStart),interest=0n,fees=0n,arrears=['cancelled','planned'].includes(l.status)?0n:BigInt(l.openingAccruedInterest||0);for(const e of events)if(['payment','early'].includes(e.type)){principal-=BigInt(e.principal);interest+=BigInt(e.interest);fees+=BigInt(e.fees);arrears-=BigInt(e.openingInterestPaid||0);}return {principal,interest,fees,overpayment:interest+fees,arrears,events};}
  const pendingLoanRows=(s,l)=>s.loanSchedules.filter(r=>r.loanId===l.id&&r.status==='planned').sort((a,b)=>a.date.localeCompare(b.date)||a.index-b.index);
  function loanPreview(s,l,p){
    const st=loanState(s,l),principal=amountOf(p.principal,l.currency,s,true);requireThat(principal<=st.principal,'Тело платежа больше остатка долга.','principal');const pending=pendingLoanRows(s,l),selected=p.rowId?pending.find(r=>r.id===p.rowId):null;requireThat(!p.rowId||selected,'Строка уже оплачена или изменена.');let dates=pending.filter(r=>r.id!==p.rowId).map(r=>r.date),months=dates.length,newPrincipal=st.principal-principal,rows=[];
    const annual=l.annualRate,first=dates[0]||monthlyDate(nextMonth((p.date||today(s)).slice(0,7)),l.paymentDay),keepPayment=pending[0]?BigInt(pending[0].principal)+BigInt(pending[0].interest):BigInt(l.basePayment),keepBody=pending[0]?BigInt(pending[0].principal):BigInt(l.baseBody);
    if(newPrincipal){if(p.earlyMode==='term'){months=600;rows=loanSchedule(newPrincipal,annual,months,first,l.paymentDay,l.model,l.model==='annuity'?keepPayment:null,l.model==='differentiated'?keepBody:null);}
      else {if(!months){months=Number(p.newRemainingMonths);requireThat(Number.isInteger(months)&&months>=1&&months<=600,'Остался долг: укажите новый оставшийся срок.','newRemainingMonths');dates=null;}rows=loanSchedule(newPrincipal,annual,months,first,l.paymentDay,l.model,null,null,dates);}}
    const oldOver=pending.reduce((n,r)=>n+BigInt(r.interest)+BigInt(r.fees),st.arrears),future=rows.reduce((n,r)=>n+r.interest+BigInt(l.regularFee),0n),paymentOverpayment=amountOf(p.interest||'0',l.currency,s,true)+amountOf(p.fees||'0',l.currency,s,true);
    return {principal:newPrincipal,rows,oldCount:pending.length,newCount:rows.length,oldEnd:pending.at(-1)?.date||null,newEnd:rows.at(-1)?.date||null,oldOverpayment:oldOver,newOverpayment:future,paymentOverpayment,saving:oldOver-future-paymentOverpayment};
  }
  function debtState(s,d){let principal=d.status==='cancelled'?0n:BigInt(d.initialPrincipal),interest=0n;for(const e of contractEvents(s,'debtEvents',d.id))if(e.type==='return'){principal-=BigInt(e.principal);interest+=BigInt(e.interest);}return {principal,interest};}
  function contractOperation(s,p,u){
    operationDate(s,{...p,time:p.time||'12:00'});const before=clone(s),w=walletActive(s,p.walletId);requireThat(w.currency===p.currency,'Валюты договора и кошелька должны совпадать.','walletId');
    const old=p.priorOperation||null,historical=old&&old.effectiveDate===p.date?s.postings.find(row=>row.operationId===old.priorRevisionId&&row.currency===p.currency):null,rate=historical?historical.rateSnapshot:old?.effectiveDate===p.date?old.incomeComponents?.[0]?.rateSnapshot??rateAt(s,p.currency,p.date):rateAt(s,p.currency,p.date),o=stamp({id:id(),groupId:old?.groupId||id(),businessType:p.kind,effectiveDate:p.date,effectiveTime:p.time||'12:00',status:'posted',actorId:u.id,memberId:'',comment:p.comment||'',walletId:w.id,currency:p.currency,amount:BigInt(p.amount).toString(),revision:old?old.revision+1:1,priorRevisionId:old?.id||null,ledgerSequence:family(s).revision+1,links:{contract:clone(p.contract)},incomeComponents:[],cashDirection:p.cashDirection??(BigInt(p.walletDelta||0)>0n?1:BigInt(p.walletDelta||0)<0n?-1:0)},u.id);o.revision=old?old.revision+1:1;
    s.operations.push(o);
    const post=(accountType,accountId,a)=>{if(!a)return;s.postings.push({id:id(),operationId:o.id,accountType,accountId,currency:p.currency,signedAmount:a.toString(),rubSnapshot:inRub(s,a,p.currency,p.date,rate)?.toString()??null,rateSnapshot:rate});};
    post('wallet',w.id,BigInt(p.walletDelta||0));if(p.depositId)post('deposit',p.depositId,BigInt(p.depositDelta||0));
    for(const c of p.incomes||[])o.incomeComponents.push({amount:BigInt(c.amount).toString(),currency:p.currency,categoryId:c.categoryId||'deposit_interest',origin:c.origin||'current',rubSnapshot:inRub(s,c.amount,p.currency,p.date,rate)?.toString()??null,rateSnapshot:rate});
    if(p.expense&&BigInt(p.expense)>0n)s.expenseLines.push({id:id(),operationId:o.id,orderIndex:0,categoryId:p.expenseCategory||'credit',memberId:'',amount:p.expense.toString(),currency:p.currency,rubSnapshot:inRub(s,p.expense,p.currency,p.date,rate)?.toString()??null});
    operationReserves(s,{reserveActions:p.reserveActions||[]},o,null);validateBalances(before,s,!!p.allowOverdraft,p.overdraftReason||'');validateReserves(s);audit(s,u.id,'contract.operation',o.id,TYPE[p.kind],{reason:p.reason||'',revisionRefs:old?[old.id,o.id]:[o.id]});return o;
  }
  function contractPlan(s,module,contractId,key,row){let p=s.plans.find(p=>p.contractKey===key);if(!p){p=stamp({id:id(),seriesId:null,occurrenceKey:null,...row,module,moduleId:contractId,contractKey:key,status:'planned',reserveCoverage:null,finalizedAt:null},session?.id||'system');s.plans.push(p);}if(planState(s,p).paid===0n)Object.assign(p,row,{status:'planned'});return p;}
  function fulfillContractPlan(s,p,o){const amount=o.amount;s.planLinks.push(stamp({id:id(),planId:p.id,operationId:o.id,appliedAmountInPlanCurrency:amount,coveredAmount:'0',finalize:true,status:'active'},o.actorId));o.links.planId=p.id;p.status='fulfilled';}
  function syncContractPlans(s){
    for(const d of s.deposits){const needed=new Set();if(d.status==='active'){
      const projection=depositProjection(s,d,d.endDate,{future:true});for(const r of projection.rows){if(d.capitalizes&&!r.closing)continue;const key=`deposit:${d.id}:${r.date}`,amount=(r.closing?r.principal:0n)+r.amount;needed.add(key);contractPlan(s,'deposit',d.id,key,{kind:'income',date:r.date,amount:amount.toString(),walletId:d.payoutWalletId,currency:d.currency,categoryId:'deposit_interest',comment:d.name+(r.closing?' · возврат вклада':' · проценты')});}}
      for(const p of s.plans.filter(p=>p.module==='deposit'&&p.moduleId===d.id))if(!needed.has(p.contractKey)&&!planState(s,p).paid)p.status='cancelled';
    }
    for(const l of s.loans){const st=loanState(s,l),rows=pendingLoanRows(s,l),needed=new Set();if(l.status==='planned'){const key='loan-receive:'+l.id;needed.add(key);contractPlan(s,'loan',l.id,key,{kind:'income',date:l.openingDate,amount:l.principalAtStart,walletId:l.walletId,currency:l.currency,categoryId:'other_income',comment:l.name+' · получение заемных денег'});}for(const [i,r]of rows.entries())if(l.status!=='cancelled'){const key='loan:'+r.id;needed.add(key);contractPlan(s,'loan',l.id,key,{kind:'expense',date:r.date,amount:(BigInt(r.principal)+BigInt(r.interest)+BigInt(r.fees)+(i===0?st.arrears:0n)).toString(),walletId:l.walletId,currency:l.currency,categoryId:'credit',comment:l.name+' · платеж',scheduleRowId:r.id});}for(const p of s.plans.filter(p=>p.module==='loan'&&p.moduleId===l.id))if(!needed.has(p.contractKey)&&!planState(s,p).paid)p.status='cancelled';}
    for(const d of s.personalDebts){const st=debtState(s,d),key='debt:'+d.id;if(st.principal>0n&&d.dueDate&&(d.direction==='owe'||d.expectedReturn)&&d.status!=='cancelled'){
      const p=contractPlan(s,'debt',d.id,key,{kind:d.direction==='owe'?'expense':'income',date:d.dueDate,amount:d.initialPrincipal,walletId:d.walletId,currency:d.currency,categoryId:d.direction==='owe'?'other_expense':'other_income',comment:(d.direction==='owe'?'Вернуть: ':'Ожидается от: ')+d.counterparty});
      // Principal expectation already contains only the unpaid remainder, so no second partial deduction.
      p.date=d.dueDate;p.walletId=d.walletId;p.status='planned';if(!planState(s,p).remaining)p.status='fulfilled';
    }else {const p=s.plans.find(p=>p.contractKey===key);if(p)p.status='cancelled';}}
    syncPlans(s);
  }
  function newLoanRows(s,l,rows,eventId=null){const version=(l.scheduleVersion||0)+1;l.scheduleVersion=version;for(const [index,r]of rows.entries())s.loanSchedules.push(stamp({id:id(),loanId:l.id,version,index,date:r.date,principal:r.principal.toString(),interest:r.interest.toString(),fees:l.regularFee,balance:r.balance.toString(),status:'planned',createdByEventId:eventId},session.id));}
  function latestContractEvent(s,module,contractId){return contractEvents(s,module==='deposit'?'depositEvents':module==='loan'?'loanEvents':'debtEvents',contractId).at(-1);}
  function cancelContractEvent(s,p,u){
    needOwner(u);const store=p.module==='deposit'?'depositEvents':p.module==='loan'?'loanEvents':'debtEvents',e=get(s,store,p.eventId);requireThat(e&&e.contractId===p.contractId,'Событие не найдено.');const last=latestContractEvent(s,p.module,p.contractId);requireThat(last?.id===e.id,'Сначала отмените последующие зависимые выплаты, начиная с последней.');const o=get(s,'operations',e.operationId);requireThat(o?.status==='posted','Событие уже изменено.');checkText(p.reason||'',3,300,'Причина','reason');const before=clone(s);o.status='superseded';const cancelled={...clone(o),id:id(),status:'cancelled',priorRevisionId:o.id,revision:o.revision+1,updatedAt:now()};s.operations.push(cancelled);for(const link of s.planLinks.filter(l=>l.operationId===o.id))link.status='reversed';
    if(p.module==='loan'){const l=get(s,'loans',e.contractId);for(const r of s.loanSchedules.filter(r=>r.loanId===l.id)){const prior=e.scheduleBefore?.find(x=>x.id===r.id);if(prior)r.status=prior.status;else if(r.createdByEventId===e.id)r.status='cancelled';}if(e.type==='open'){l.status=e.wasPlanned?'planned':'cancelled';if(!e.wasPlanned)for(const r of pendingLoanRows(s,l))r.status='cancelled';}else l.status='active';}
    if(p.module==='deposit'){const d=get(s,'deposits',e.contractId);d.status=e.type==='open'?'cancelled':'active';}
    if(p.module==='debt'){const d=get(s,'personalDebts',e.contractId);d.status=e.type==='open'?'cancelled':'active';}
    syncContractPlans(s);validateBalances(before,s,false);validateReserves(s);audit(s,u.id,'contract.cancel',cancelled.id,'Отменено: '+TYPE[o.businessType],{reason:p.reason,revisionRefs:[o.id,cancelled.id]});return cancelled;
  }
  function openDB() {
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(APP,DB_VERSION);
      req.onupgradeneeded=()=>{const d=req.result;for(const name of STORES)if(!d.objectStoreNames.contains(name))d.createObjectStore(name,{keyPath:name==='meta'?'key':'id'});};
      req.onsuccess=()=>{const d=req.result;d.onversionchange=()=>{d.close();fatal('База обновлена в другой вкладке. Обновите страницу.');};resolve(d);};
      req.onerror=()=>reject(new AppError('Не удалось открыть хранилище. Проверьте разрешения браузера.'));
      req.onblocked=()=>reject(new AppError('Закройте старые вкладки приложения и обновите страницу.'));
    });
  }
  function readAll() {
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORES,'readonly'),s={};
      for(const name of STORES){const r=tx.objectStore(name).getAll();r.onsuccess=()=>s[name]=r.result;}
      tx.oncomplete=()=>resolve(s);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }
  // Every command re-reads authoritative data inside a serial read/write transaction.
  function transaction(fn) {
    return new Promise((resolve,reject)=>{
      let result,error,count=0;const tx=db.transaction(STORES,'readwrite'),s={};
      for(const name of STORES){const req=tx.objectStore(name).getAll();req.onsuccess=()=>{
        s[name]=req.result;if(++count!==STORES.length)return;
        try {
          const before=clone(s);result=fn(s);
          for(const store of STORES){const key=store==='meta'?'key':'id',old=new Map(before[store].map(x=>[x[key],x])),fresh=new Set(s[store].map(x=>x[key]));
            for(const row of s[store])if(!old.has(row[key])||JSON.stringify(row)!==JSON.stringify(old.get(row[key])))tx.objectStore(store).put(row);
            for(const row of before[store])if(!fresh.has(row[key]))tx.objectStore(store).delete(row[key]);
          }
        }catch(e){error=e instanceof AppError?e:new AppError('Не удалось сохранить. Данные не изменены; повторите попытку.','','STORAGE');tx.abort();}
      };}
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(error||new AppError('Не удалось сохранить. Данные не изменены; повторите попытку.','','STORAGE'));tx.onerror=()=>{error=error||new AppError('Не удалось сохранить. Проверьте свободное место и повторите попытку.','','STORAGE');};
    });
  }
  const metaGet = (s,key) => s.meta.find(x=>x.key===key)?.value;
  function metaSet(s,key,value){const row=s.meta.find(x=>x.key===key);if(row)row.value=value;else s.meta.push({key,value});}
  function audit(s,actorId,action,entityId,summary,extra={}){s.audit.push({id:id(),actorId,action,entityType:action.split('.')[0],entityId,summary,timestamp:now(),...extra});}
  function stamp(row,actorId){return {...row,createdAt:now(),updatedAt:now(),createdBy:actorId,revision:1};}
  const baseCurrencies = () => [['RUB','Российский рубль',2,'fiat'],['USD','Доллар США',2,'fiat'],['EUR','Евро',2,'fiat'],['USDT','Tether',6,'crypto'],['BTC','Bitcoin',8,'crypto'],['ETH','Ethereum',18,'crypto']].map(([code,displayName,decimals,kind])=>({id:code,code,displayName,decimals,kind,active:true}));
  function baseCategories() {
    const names={income:[['salary','Зарплата'],['advance','Аванс'],['vacation','Отпускные'],['gift','Подарки'],['side','Подработка'],['sale','Продажа вещей'],['win','Выигрыши и лотерея'],['deposit_interest','Проценты по депозиту'],['past_refund','Возврат прошлых покупок'],['other_income','Прочие поступления']],expense:[['groceries','Продукты'],['transport','Транспорт'],['clothes','Одежда'],['home','Жилье и коммунальные услуги'],['health','Здоровье'],['fun','Развлечения'],['credit','Кредиты'],['subscriptions','Подписки'],['unexpected','Непредвиденные расходы'],['bank_fees','Банковские комиссии'],['other_fees','Прочие комиссии'],['other_expense','Прочее']]};
    return Object.entries(names).flatMap(([type,rows])=>rows.map(([systemCode,name],i)=>({id:systemCode,name,type,systemCode,color:PALETTE[i%PALETTE.length],archived:false,locked:['bank_fees','other_fees','credit','deposit_interest'].includes(systemCode)})));
  }
  const bytesHex = bytes => [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
  const hexBytes = hex => Uint8Array.from(hex.match(/../g),x=>parseInt(x,16));
  async function passwordHash(password,salt=bytesHex(crypto.getRandomValues(new Uint8Array(16)))) {
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:hexBytes(salt),iterations:600000},key,256);
    return {passwordHash:bytesHex(bits),passwordSalt:salt,passwordIterations:600000};
  }
  function checkPassword(p,confirmation){requireThat(p.length>=8&&p.length<=128,'Пароль должен содержать от 8 до 128 символов.','password');if(confirmation!==undefined)requireThat(p===confirmation,'Пароли не совпадают.','confirmPassword');}
  const loginName = x => String(x||'').trim().toLowerCase();
  function checkLogin(x){requireThat(/^[a-z0-9._-]{3,40}$/.test(loginName(x)),'Логин: 3–40 латинских букв, цифр, точек, дефисов или подчеркиваний.','login');}
  function checkText(x,min,max,label,field=''){requireThat(typeof x==='string'&&x.trim().length>=min&&x.trim().length<=max,`${label}: от ${min} до ${max} символов.`,field);return x.trim();}
  async function login(login,password) {
    const s=await readAll(),name=loginName(login),u=s.users.find(x=>x.loginNormalized===name);
    const attempt=metaGet(s,'login:'+name);requireThat(!attempt||attempt.until<=Date.now(),'Слишком много попыток. Подождите одну минуту.','login');
    let matches=false;if(u){const hash=await passwordHash(password,u.passwordSalt);matches=hash.passwordHash===u.passwordHash&&u.status==='active';}
    await transaction(d=>{const current=d.users.find(x=>x.loginNormalized===name),info=metaGet(d,'login:'+name)||{count:0,until:0};
      requireThat(info.until<=Date.now(),'Слишком много попыток. Подождите одну минуту.','login');
      if(matches&&current?.passwordHash===u.passwordHash&&current.status==='active')metaSet(d,'login:'+name,{count:0,until:0});else{matches=false;const count=info.count+1;metaSet(d,'login:'+name,{count:count>=5?0:count,until:count>=5?Date.now()+60000:0});}
    });
    requireThat(matches,'Неверный логин или пароль.','password');
    session={id:u.id,authVersion:u.authVersion};lastActivity=Date.now();data=await readAll();applyTheme(u.preferences?.theme||'light');render();
    if(u.mustChangePassword)passwordDialog(true);else await reconcile();
  }
  function ensureActor(s){const u=session&&get(s,'users',session.id);requireThat(u&&u.status==='active'&&u.authVersion===session.authVersion,'Профиль заблокирован или пароль изменен. Войдите заново.','','SESSION');return u;}
  function needOwner(u){requireThat(u.role==='owner','Это действие доступно только владельцу.','','FORBIDDEN');}
  function needWrite(u){requireThat(['owner','editor'].includes(u.role),'Недостаточно прав для прямой записи.','','FORBIDDEN');}
  function operationDate(s,p){requireThat(validDate(p.date),'Укажите корректную дату.','date');requireThat(p.date>=family(s).startDate,'Дата раньше начала семейного учета.','date');requireThat(p.date<=today(s),'Нельзя записать будущую операцию как совершенную. Выберите дату не позже сегодняшней.','date');requireThat(family(s).startDate<=today(s),'До даты начала доступны только настройки.','date');requireThat(/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time||''),'Укажите корректное время.','time');}
  function timeline(s,walletId) {
    const ops=new Map(active(s).map(x=>[x.id,x])),events=[];
    for(const post of s.postings)if(post.accountId===walletId&&ops.has(post.operationId)){const o=ops.get(post.operationId);events.push({key:o.effectiveDate+'T'+o.effectiveTime,amount:BigInt(post.signedAmount)});}
    return events;
  }
  function validateBalances(before,after,allow=false,reason='') {
    for(const w of after.wallets){const prev=get(before,'wallets',w.id);let old=BigInt(prev?.openingBalance||0),fresh=BigInt(w.openingBalance);const a=timeline(before,w.id),b=timeline(after,w.id),keys=[...new Set([...a,...b].map(x=>x.key))].sort();
      if(fresh<old&&fresh<0n)throw new AppError('Начальный остаток не может быть отрицательным.');
      const oldDeltas=new Map(),newDeltas=new Map();for(const event of a)oldDeltas.set(event.key,(oldDeltas.get(event.key)||0n)+event.amount);for(const event of b)newDeltas.set(event.key,(newDeltas.get(event.key)||0n)+event.amount);
      for(const key of keys){old+=oldDeltas.get(key)||0n;fresh+=newDeltas.get(key)||0n;
        if(fresh<0n&&fresh<old){requireThat(allow&&String(reason).trim().length>=3,`На счете «${w.name}» не хватает денег (${money(fresh,w.currency,after)}). Подтвердите отрицательный остаток и укажите причину.`,'overdraftReason','INSUFFICIENT');}
      }
    }
  }
  function walletActive(s,key,field='walletId'){const w=get(s,'wallets',key);requireThat(w&&!w.archived,'Выберите действующий кошелек.',field);return w;}
  function category(s,key,type,allowArchived=false){const c=get(s,'categories',key);requireThat(c&&c.type===type&&(!c.archived||allowArchived),'Выберите подходящую категорию.','categoryId');return c;}
  function buildOperation(s,p,u,old=null,createdBy=null) {
    operationDate(s,p);requireThat(MANUAL_TYPES.includes(p.kind),'Договорная операция проводится только из договора.');checkText(p.comment||'',0,1000,'Комментарий','comment');
    const w=walletActive(s,p.walletId),dec=get(s,'currencies',w.currency).decimals;
    let amount;try{amount=parseMoney(p.amount,dec);}catch(e){e.field='amount';throw e;}
    if(p.memberId)requireThat(family(s).members.some(m=>m.id===p.memberId),'Выберите существующую пометку члена семьи.','memberId');
    requireThat(!p.overdraftReason||String(p.overdraftReason).length<=300,'Причина должна быть не длиннее 300 символов.','overdraftReason');
    const o=stamp({id:id(),groupId:old?.groupId||id(),businessType:p.kind,effectiveDate:p.date,effectiveTime:p.time,status:'posted',actorId:createdBy||u.id,memberId:p.memberId||'',comment:(p.comment||'').trim(),walletId:w.id,currency:w.currency,amount:amount.toString(),revision:old?old.revision+1:1,priorRevisionId:old?.id||null,ledgerSequence:family(s).revision+1,links:{},overdraftReason:p.allowOverdraft?p.overdraftReason||'':'',negativeConfirmed:!!p.allowOverdraft},u.id);
    o.revision=old?old.revision+1:1;
    const posts=[],lines=[];
    const valuationRate=code=>{const historical=old&&old.effectiveDate===p.date?s.postings.find(row=>row.operationId===old.id&&row.currency===code):null;return historical?historical.rateSnapshot:rateAt(s,code,p.date);};
    const valuation=(value,code)=>inRub(s,value,code,p.date,valuationRate(code));
    const post=(wallet,value)=>posts.push({id:id(),operationId:o.id,accountType:'wallet',accountId:wallet.id,currency:wallet.currency,signedAmount:value.toString(),rubSnapshot:valuation(value,wallet.currency)?.toString()??null,rateSnapshot:valuationRate(wallet.currency)});
    const line=(amount,categoryId,memberId,extra={})=>{category(s,categoryId,'expense',!!old||p.kind==='refund');const l={id:id(),operationId:o.id,orderIndex:lines.length,categoryId,memberId:memberId||'',amount:amount.toString(),currency:w.currency,rubSnapshot:valuation(amount,w.currency)?.toString()??null,...extra};lines.push(l);return l;};
    if(p.kind==='income'){category(s,p.categoryId,'income',!!old);o.categoryId=p.categoryId;o.rateSnapshot=valuationRate(w.currency);o.rubSnapshot=valuation(amount,w.currency)?.toString()??null;post(w,amount);}
    if(p.kind==='expense'){post(w,-amount);const parts=p.lines?.length?p.lines:[{amount:p.amount,categoryId:p.categoryId,memberId:p.memberId}];let sum=0n;
      let allocated=0n;
      for(const part of parts){const n=parseMoney(part.amount,dec);sum+=n;if(part.memberId)requireThat(family(s).members.some(m=>m.id===part.memberId),'Неизвестная пометка в строке покупки.');const l=line(n,part.categoryId,part.memberId);const cumulative=valuation(sum,w.currency);if(cumulative!==null){l.rubSnapshot=(cumulative-allocated).toString();allocated=cumulative;}}
      requireThat(sum===amount,'Сумма категорий должна совпадать с общей суммой.','amount');o.categoryId=lines.length===1?lines[0].categoryId:null;
    }
    if(p.kind==='refund'){
      const original=active(s).find(x=>x.groupId===p.originalGroupId);requireThat(original?.businessType==='expense','Исходный расход не найден.','originalGroupId');requireThat(original.currency===w.currency,'Валюта возврата должна совпадать с покупкой.','walletId');requireThat(p.date>=original.effectiveDate,'Возврат не может быть раньше покупки.','date');
      const originalLines=s.expenseLines.filter(x=>x.operationId===original.id),chosen=originalLines.find(x=>x.id===p.originalLineId);requireThat(chosen,'Выберите категорию исходной покупки.','originalLineId');
      const activeIds=new Set(active(s).filter(x=>x.id!==old?.id).map(x=>x.id));const returned=s.expenseLines.filter(x=>activeIds.has(x.operationId)&&x.originalLineId===chosen.id).reduce((a,x)=>a-BigInt(x.amount),0n);
      requireThat(amount<=BigInt(chosen.amount)-returned,'Возврат превышает невозвращенную сумму этой категории.','amount');
      const cumulativeRub=chosen.rubSnapshot===null?null:rounded(BigInt(chosen.rubSnapshot)*(returned+amount),BigInt(chosen.amount));
      const previousRefundRub=s.expenseLines.filter(x=>activeIds.has(x.operationId)&&x.originalLineId===chosen.id&&x.rubSnapshot!==null).reduce((a,x)=>a-BigInt(x.rubSnapshot),0n);
      const exactRub=cumulativeRub===null?null:cumulativeRub-previousRefundRub;
      line(-amount,chosen.categoryId,chosen.memberId,{rubSnapshot:exactRub===null?null:(-exactRub).toString(),originalLineId:chosen.id});post(w,amount);o.links.originalGroupId=original.groupId;o.originalLineId=chosen.id;
    }
    if(p.kind==='transfer'||p.kind==='fx'){
      const target=walletActive(s,p.targetId,'targetId');requireThat(target.id!==w.id,'Выберите два разных счета.','targetId');
      requireThat(p.kind==='fx'?target.currency!==w.currency:target.currency===w.currency,p.kind==='fx'?'Для одной валюты используйте перевод.':'Для разных валют используйте обмен.','targetId');
      let received=amount;
      if(p.kind==='fx'){
        if(p.fxMode==='rate'){const k=parseMoney(p.fxRate,12);received=rounded(amount*k*p10(get(s,'currencies',target.currency).decimals),p10(dec)*p10(12));requireThat(received>0n,'Полученная сумма меньше точности валюты.','fxRate');}
        else received=amountOf(p.receivedAmount,target.currency,s);
        o.fxRate=plain(rounded(received*p10(dec)*p10(12),amount*p10(get(s,'currencies',target.currency).decimals)),12);o.quotedRate=p.fxRate||null;
      }
      o.targetId=target.id;o.receivedAmount=received.toString();o.targetCurrency=target.currency;post(w,-amount);post(target,received);
      if(p.feeAmount && /[1-9]/.test(p.feeAmount)){
        const feeWallet=walletActive(s,p.feeWalletId||w.id,'feeWalletId'),fee=amountOf(p.feeAmount,feeWallet.currency,s);category(s,p.feeCategoryId,'expense');requireThat(['bank_fees','other_fees'].includes(p.feeCategoryId),'Выберите вид комиссии.','feeCategoryId');
        post(feeWallet,-fee);lines.push({id:id(),operationId:o.id,orderIndex:0,categoryId:p.feeCategoryId,memberId:'',amount:fee.toString(),currency:feeWallet.currency,rubSnapshot:valuation(fee,feeWallet.currency)?.toString()??null});o.fee={walletId:feeWallet.id,amount:fee.toString(),categoryId:p.feeCategoryId,currency:feeWallet.currency};
      }else if(p.feeAmount)amountOf(p.feeAmount,w.currency,s,true);
      if(p.saveFxRate&&p.kind==='fx'){
        requireThat(w.currency==='RUB'||target.currency==='RUB','Справочный RUB-курс можно вывести только из пары с RUB.','saveFxRate');
        const foreign=w.currency==='RUB'?target:w,foreignAmount=w.currency==='RUB'?received:amount,rubAmount=w.currency==='RUB'?amount:received;
        const rate=plain(rounded(rubAmount*p10(get(s,'currencies',foreign.currency).decimals)*p10(12),foreignAmount*100n),12);
        s.rates.push(stamp({id:id(),currency:foreign.currency,effectiveDate:p.date,rubPerUnit:rate,enteredAt:now(),enteredBy:u.id},u.id));
      }
    }
    return {operation:o,postings:posts,lines};
  }
  function dependentReturns(s,o){
    if(o.businessType==='refund')return active(s).some(x=>x.businessType==='refund'&&x.links?.originalGroupId===o.links?.originalGroupId&&x.originalLineId===o.originalLineId&&(x.ledgerSequence??0)>(o.ledgerSequence??0));
    return active(s).some(x=>x.links?.originalGroupId===o.groupId);
  }
  function mayEdit(u,o,s){return u.role==='owner'||(u.role==='editor'&&o.actorId===u.id&&o.effectiveDate===today(s)&&!dependentReturns(s,o));}
  function saveOperation(s,p,u,old=null,actorId=null) {
    requireThat(!old?.links?.contract,'Исправьте событие из карточки договора.');
    if(old){requireThat(old.status==='posted','Запись уже изменена. Обновите форму.','','CONFLICT');requireThat(mayEdit(u,old,s),'Для этой записи отправьте запрос владельцу.','','FORBIDDEN');requireThat(!dependentReturns(s,old),'Сначала отмените связанные или более поздние возвраты.');checkText(p.reason||'',3,300,'Причина исправления','reason');}
    const before=clone(s),built=buildOperation(s,p,u,old,actorId||old?.actorId);
    if(old)old.status='superseded';s.operations.push(built.operation);s.postings.push(...built.postings);s.expenseLines.push(...built.lines);
    planLink(s,p,built.operation,old);operationReserves(s,p,built.operation,old);syncPlans(s);
    validateBalances(before,s,!!p.allowOverdraft,p.overdraftReason);validateReserves(s);
    audit(s,u.id,old?'operation.edit':'operation.create',built.operation.id,`${TYPE[p.kind]}: ${money(built.operation.amount,built.operation.currency,s)}`,{reason:p.reason||'',revisionRefs:old?[old.id,built.operation.id]:[built.operation.id]});
    return built.operation.id;
  }
  function cancelOperation(s,key,u,reason,allowOverdraft=false,overdraftReason='') {
    requireThat(!get(s,'operations',key)?.links?.contract,'Отмените событие из карточки договора.');
    const o=get(s,'operations',key);requireThat(o?.status==='posted','Запись уже изменена.','','CONFLICT');requireThat(mayEdit(u,o,s),'Отправьте запрос владельцу.','','FORBIDDEN');requireThat(!dependentReturns(s,o),'Сначала отмените связанные или более поздние возвраты.');checkText(reason,3,300,'Причина отмены','reason');
    const before=clone(s);o.status='superseded';const revision={...clone(o),id:id(),status:'cancelled',priorRevisionId:o.id,revision:o.revision+1,updatedAt:now(),createdBy:u.id};s.operations.push(revision);for(const l of s.planLinks.filter(l=>l.operationId===o.id))l.status='reversed';syncPlans(s);validateBalances(before,s,allowOverdraft,overdraftReason);validateReserves(s);audit(s,u.id,'operation.cancel',revision.id,'Отмена: '+TYPE[o.businessType],{reason,revisionRefs:[o.id,revision.id]});return revision.id;
  }
  function planFields(s,p,old=null){
    const w=walletActive(s,p.walletId);requireThat(['income','expense'].includes(p.kind),'Выберите доход или расход.');category(s,p.categoryId,p.kind,!!old);
    requireThat(validDate(p.date)&&p.date>=family(s).startDate,'Дата плана раньше начала учета или некорректна.','date');
    const amount=amountOf(p.amount,w.currency,s);let reserveCoverage=null;
    if(p.coverageGoalId){requireThat(p.kind==='expense','Покрытие возможно только для расхода.');const g=get(s,'goals',p.coverageGoalId);requireThat(g&&g.status!=='archived','Цель не найдена.');const coverage=amountOf(p.coverageAmount,w.currency,s);requireThat(coverage<=amount,'Покрытие больше суммы плана.','coverageAmount');reserveCoverage={goalId:g.id,walletId:w.id,amount:coverage.toString()};}
    return {kind:p.kind,date:p.date,amount:amount.toString(),walletId:w.id,currency:w.currency,categoryId:p.categoryId,comment:checkText(p.comment||'',0,1000,'Комментарий','comment'),reserveCoverage};
  }
  function executePlanning(s,type,p,u){
    needOwner(u);const f=family(s);
    if(type==='planning.settings'){f.expectedMonthlyIncome=amountOf(p.expectedMonthlyIncome,'RUB',s,true).toString();audit(s,u.id,type,f.id,'Ожидаемый месячный доход изменен');return;}
    if(type==='plan.save'){
      const old=p.id?get(s,'plans',p.id):null;requireThat(!p.id||old,'План не найден.');requireThat(!old?.module,'Договорный план изменяется через договор.');
      const row=planFields(s,p,old);if(old){requireThat(!['cancelled','skipped','fulfilled'].includes(old.status),'Закрытый план не изменяется.');const st=planState(s,old);if(st.paid)requireThat(old.kind===row.kind&&old.currency===row.currency,'Тип и валюта частично исполненного плана неизменны.');if(row.reserveCoverage)row.reserveCoverage.amount=(BigInt(row.reserveCoverage.amount)+st.links.reduce((n,l)=>n+BigInt(l.coveredAmount||0),0n)).toString();Object.assign(old,row,{updatedAt:now(),revision:old.revision+1,autoOverride:true,error:null});syncPlans(s);}
      else s.plans.push(stamp({id:id(),...row,status:'planned',seriesId:null,occurrenceKey:null,finalizedAt:null,finalizationReason:null},u.id));
      validateReserves(s);audit(s,u.id,type,old?.id||s.plans.at(-1).id,'План сохранен');return old?.id||s.plans.at(-1).id;
    }
    if(type==='plan.status'){
      const plan=get(s,'plans',p.id);requireThat(plan&&!plan.module,'Обычный план не найден.');requireThat(['skipped','cancelled','planned'].includes(p.status),'Неизвестный статус.');plan.status=p.status;plan.error=null;plan.autoOverride=true;plan.revision++;syncPlans(s);validateReserves(s);audit(s,u.id,type,plan.id,'Ожидание плана: '+p.status);return;
    }
    if(type==='series.save'){
      const series=p.id?get(s,'series',p.id):null;requireThat(!p.id||series,'Серия не найдена.');
      const fields=planFields(s,{...p,date:p.start},null),day=Number(p.monthlyDay);requireThat(Number.isInteger(day)&&day>=1&&day<=31,'День месяца от 1 до 31.','monthlyDay');requireThat(!p.end||(validDate(p.end)&&p.end>=p.start),'Дата окончания раньше начала.','end');
      if(series){requireThat(validDate(p.from)&&p.from>=today(s),'Изменение будущих платежей начинается не раньше сегодня.','from');for(const plan of s.plans.filter(x=>x.seriesId===series.id&&x.date>=p.from&&!planState(s,x).paid)){plan.status='cancelled';plan.autoOverride=true;plan.revision++;}series.status='cancelled';}
      const row=stamp({id:id(),kind:p.kind,monthlyDay:day,start:series?(p.start>p.from?p.start:p.from):p.start,end:p.end||null,template:{...fields,reserveCoverage:null},autoPost:!!p.autoPost,status:'active'},u.id);s.series.push(row);materialize(s,monthEnd(nextMonth(today(s).slice(0,7),12)+'-01'));validateReserves(s);audit(s,u.id,type,row.id,series?'Серия изменена с выбранной даты':'Создана ежемесячная серия');return row.id;
    }
    if(type==='series.cancel'){const series=get(s,'series',p.id);requireThat(series,'Серия не найдена.');series.status='cancelled';for(const plan of s.plans.filter(x=>x.seriesId===series.id&&x.date>=today(s)&&!planState(s,x).paid)){plan.status='cancelled';plan.revision++;}validateReserves(s);audit(s,u.id,type,series.id,'Будущие платежи серии отменены; просроченные сохранены');return;}
    if(type==='limit.save'){
      if(p.categoryId)category(s,p.categoryId,'expense',true);const amount=amountOf(p.amount,'RUB',s,true);requireThat(!p.month||/^\d{4}-\d{2}$/.test(p.month)&&validDate(p.month+'-01'),'Выберите месяц.','month');let row=s.limits.find(x=>(x.categoryId||'')===(p.categoryId||''));
      if(!row){row=stamp({id:id(),categoryId:p.categoryId||null,defaultAmountRub:null,monthOverrides:{}},u.id);s.limits.push(row);}if(p.month){if(p.remove)delete row.monthOverrides[p.month];else row.monthOverrides[p.month]=amount.toString();}else row.defaultAmountRub=p.remove?null:amount.toString();row.updatedAt=now();audit(s,u.id,type,row.id,'Месячный лимит изменен');return;
    }
    if(type==='goal.save'){
      const g=p.id?get(s,'goals',p.id):null;requireThat(!p.id||g,'Цель не найдена.');requireThat(!g||g.status!=='archived','Архивную цель нельзя изменять.');requireThat(get(s,'currencies',p.currency),'Валюта не найдена.');requireThat(!g||g.currency===p.currency,'Валюта существующей цели неизменна.');
      const target=amountOf(p.target,p.currency,s),day=Number(p.contributionDay);requireThat(Number.isInteger(day)&&day>=1&&day<=31,'День взноса от 1 до 31.','contributionDay');requireThat(validDate(p.firstDate)&&(p.firstDate===g?.firstDate||p.firstDate>=today(s)),'Первая дата взноса не раньше сегодня; исходную дату можно сохранить.','firstDate');requireThat(['date','pace'].includes(p.mode),'Выберите способ расчета.');
      if(p.mode==='date')requireThat(validDate(p.dueDate),'Укажите срок цели.','dueDate');let contributionAmount='0',percent='0';
      if(p.mode==='pace'){if(p.contributionType==='percent'){const n=parseMoney(p.contributionPercent,4,true);requireThat(n<=100n*p10(4),'Процент от 0 до 100.','contributionPercent');requireThat(BigInt(f.expectedMonthlyIncome||0)>0n,'Сначала укажите ожидаемый месячный доход.','contributionPercent');percent=plain(n,4);}else contributionAmount=amountOf(p.contributionAmount,p.currency,s,true).toString();}
      if(p.kind==='credit'||p.linkedLoanId)requireThat(get(s,'loans',p.linkedLoanId)&&get(s,'loans',p.linkedLoanId).status!=='cancelled','Выберите кредит для цели.','linkedLoanId');const row={name:checkText(p.name,1,100,'Название','name'),kind:p.kind==='credit'||p.linkedLoanId?'credit':'saving',linkedLoanId:p.linkedLoanId||null,currency:p.currency,target:target.toString(),mode:p.mode,dueDate:p.mode==='date'?p.dueDate:null,firstDate:p.firstDate,contributionDay:day,contributionType:p.contributionType==='percent'?'percent':'amount',contributionAmount,contributionPercent:percent,priority:[1,2,3].includes(Number(p.priority))?Number(p.priority):2,comment:checkText(p.comment||'',0,1000,'Комментарий','comment')};
      if(g)Object.assign(g,row,{revision:g.revision+1,updatedAt:now()});else {const fresh=stamp({id:id(),...row,status:'active'},u.id);s.goals.push(fresh);requireThat(!p.initialAmount||!/[1-9]/.test(p.initialAmount)||p.initialWalletId,'Выберите кошелек для начального резерва.','initialWalletId');if(p.initialWalletId&&p.initialAmount&&/[1-9]/.test(p.initialAmount))reserveCommand(s,{goalId:fresh.id,walletId:p.initialWalletId,amount:p.initialAmount,countsForMonthlyPlan:!!p.initialCounts},u);}
      audit(s,u.id,type,g?.id||s.goals.at(-1).id,'Цель сохранена: '+row.name);return g?.id||s.goals.at(-1).id;
    }
    if(type==='goal.reserve'){reserveCommand(s,p,u);audit(s,u.id,type,p.goalId,p.release?'Освобожден резерв цели':'Пополнен резерв цели');return;}
    if(type==='goal.status'){
      const g=get(s,'goals',p.id);requireThat(g&&['active','paused','completed','archived'].includes(p.status),'Цель или статус не найдены.');requireThat(g.status!=='archived','Архивная цель закрыта.');
      if(p.status==='completed'){const info=goalInfo(s,g);requireThat(!info.missing&&info.remaining===0n,'Для завершения сначала накопите целевую сумму.');}
      if(p.status==='archived'){const r=reserveBalances(s);requireThat(p.releaseConfirmed||!Object.entries(r).some(([k,a])=>k.startsWith(g.id+'|')&&a),'Подтвердите освобождение резервов.');for(const [key,a]of Object.entries(r))if(key.startsWith(g.id+'|')&&a)reserveEvent(s,g.id,key.split('|')[1],-a,today(s),null,true);}
      g.status=p.status;g.revision++;g.updatedAt=now();validateReserves(s);audit(s,u.id,type,g.id,'Статус цели: '+p.status);return;
    }
    if(type==='planning.reconcile'){
      syncContractPlans(s);const horizon=p.until||monthEnd(nextMonth(today(s).slice(0,7),12)+'-01');requireThat(validDate(horizon),'Некорректный горизонт.');materialize(s,horizon);
      if(f.startDate<=today(s))for(const plan of s.plans.filter(x=>x.date<=today(s)&&x.seriesId&&!x.autoOverride&&get(s,'series',x.seriesId)?.autoPost&&get(s,'series',x.seriesId)?.status==='active').sort((a,b)=>a.date.localeCompare(b.date)||a.occurrenceKey.localeCompare(b.occurrenceKey))){
        const st=planState(s,plan);if(!st.remaining)continue;const key='auto:'+plan.occurrenceKey+':'+plan.revision+':'+st.links.map(l=>l.id).sort().join(',');if(metaGet(s,key))continue;
        const trial=clone(s);try{const actor={...u,id:'system',role:'owner'},oid=saveOperation(trial,{kind:plan.kind,walletId:plan.walletId,categoryId:plan.categoryId,amount:plain(st.remaining,get(s,'currencies',plan.currency).decimals),date:plan.date,time:'12:00',comment:plan.comment,planId:plan.id},actor);const op=get(trial,'operations',oid);op.systemInitiatorId=u.id;for(const a of trial.audit.filter(a=>a.entityId===oid))a.systemInitiatorId=u.id;get(trial,'plans',plan.id).error=null;metaSet(trial,key,{operationId:oid});Object.assign(s,trial);}
        catch(e){get(s,'plans',plan.id).error=e.message;}
      }
      metaSet(s,'lastReconcile',now());return;
    }
    throw new AppError('Неизвестная команда планирования.');
  }
  function reserveCommand(s,p,u){
    const g=get(s,'goals',p.goalId),w=walletActive(s,p.walletId);requireThat(g&&g.status!=='archived','Выберите цель.');requireThat(family(s).startDate<=today(s),'Резерв доступен с даты начала учета.');const amount=amountOf(p.amount,w.currency,s);reserveEvent(s,g.id,w.id,p.release?-amount:amount,today(s),null,p.release?true:p.countsForMonthlyPlan!==false);validateReserves(s);
  }
  async function reconcile(until){
    if(reconciling||!owner()||user()?.mustChangePassword||modal)return;reconciling=true;
    try{await command('planning.reconcile',{until});}catch(e){if(e.code!=='CONFLICT')toast(e.message,true);}finally{reconciling=false;}
  }
  function executeContracts(s,type,p,u){
    needOwner(u);const f=family(s);
    if(type==='contract.cancel'){return cancelContractEvent(s,p,u).id;}
    if(type==='contract.void'){
      requireThat(['deposit','loan','debt'].includes(p.module),'Неизвестный договор.');const store=p.module==='deposit'?'deposits':p.module==='loan'?'loans':'personalDebts',record=get(s,store,p.id);requireThat(record&&['active','planned'].includes(record.status),'Договор не найден.');requireThat(!latestContractEvent(s,p.module,p.id),'Сначала отмените фактические события договора.');checkText(p.reason,3,300,'Причина','reason');const previous=record.status;record.status='cancelled';record.revision++;if(p.module==='loan')for(const r of pendingLoanRows(s,record))r.status='cancelled';syncContractPlans(s);audit(s,u.id,type,record.id,'Начальная запись договора отменена',{reason:p.reason,changedFields:{status:{before:previous,after:'cancelled'}}});return;
    }
    if(type==='deposit.save'){
      const d=p.id?get(s,'deposits',p.id):null;requireThat(!p.id||d,'Вклад не найден.');const w=walletActive(s,p.payoutWalletId,'payoutWalletId'),currency=d?.currency||p.currency;requireThat(w.currency===currency,'Кошелек выплаты должен быть в валюте вклада.','payoutWalletId');
      requireThat(['new','existing'].includes(p.mode),'Выберите новый или существующий вклад.');requireThat(validDate(p.openingDate)&&validDate(p.endDate)&&p.endDate>p.openingDate&&p.endDate>=f.startDate,'Проверьте даты вклада.','endDate');requireThat(p.mode!=='existing'||p.openingDate<=f.startDate,'Существующий вклад открыт не позже начала учета.','openingDate');requireThat(p.mode!=='existing'||p.noDuplicateConfirmed,'Подтвердите отсутствие этих денег в кошельках.','noDuplicateConfirmed');
      const amount=amountOf(p.principal,currency,s),initialInterest=amountOf(p.initialUnpaidInterest||'0',currency,s,true),min=amountOf(p.minBalance||'0',currency,s,true);requireThat(min<=amount,'Неснижаемый остаток больше вклада.','minBalance');requireThat(['monthly','end'].includes(p.payoutMode),'Способ выплаты не выбран.');requireThat(p.payoutMode!=='end'||!p.capitalizes,'При выплате в конце капитализация не используется.');const day=Number(p.payoutDay);requireThat(Number.isInteger(day)&&day>=1&&day<=31,'День выплаты от 1 до 31.','payoutDay');rateUnits(p.earlyRate||'0');
      let intervals=(p.rateIntervals?.length?p.rateIntervals:[{date:p.mode==='existing'?f.startDate:p.openingDate,rate:p.annualRate}]).map(r=>({date:r.date,rate:plain(rateUnits(r.rate),6)})).sort((a,b)=>a.date.localeCompare(b.date));requireThat(intervals.every((r,i)=>validDate(r.date)&&r.date<=p.endDate&&(!i||r.date!==intervals[i-1].date))&&intervals[0].date<=(p.mode==='existing'?f.startDate:p.openingDate),'Интервалы ставок должны покрывать срок без повторных дат.','annualRate');
      if(d){requireThat(d.status==='active','Вклад закрыт.');requireThat(!contractEvents(s,'depositEvents',d.id).some(e=>e.type!=='open'),'После движений меняйте только будущую ставку или сначала отмените зависимые события.');requireThat(d.mode===p.mode&&d.openingDate===p.openingDate&&d.currency===currency,'Режим, дата и валюта существующего договора неизменны.');if(d.mode==='new')requireThat(d.originalPrincipal===amount.toString(),'Сумма открытия хранится в операции; используйте пополнение или снятие.');}
      const row={name:checkText(p.name,1,100,'Название','name'),bank:checkText(p.bank||'',0,100,'Банк','bank'),currency,mode:p.mode,openingDate:p.openingDate,endDate:p.endDate,initialPrincipal:p.mode==='existing'?amount.toString():'0',originalPrincipal:amount.toString(),initialUnpaidInterest:p.mode==='existing'?initialInterest.toString():'0',rateIntervals:intervals,payoutMode:p.payoutMode,capitalizes:!!p.capitalizes,payoutDay:day,payoutWalletId:w.id,topupAllowed:!!p.topupAllowed,withdrawalAllowed:!!p.withdrawalAllowed,minBalance:min.toString(),earlyRate:plain(rateUnits(p.earlyRate||'0'),6),comment:checkText(p.comment||'',0,1000,'Комментарий','comment')};
      if(d)Object.assign(d,row,{updatedAt:now(),revision:d.revision+1});else{
        const fresh=stamp({id:id(),...row,status:'active'},u.id);s.deposits.push(fresh);if(p.mode==='new'){
          const source=walletActive(s,p.sourceWalletId,'sourceWalletId');requireThat(source.currency===currency,'Валюты источника и вклада должны совпадать.');const e=stamp({id:id(),contractId:fresh.id,type:'open',date:p.openingDate,principalDelta:amount.toString(),sequence:f.revision+1},u.id);
          const o=contractOperation(s,{kind:'deposit_open',date:p.openingDate,walletId:source.id,currency,amount,walletDelta:-amount,depositId:fresh.id,depositDelta:amount,contract:{module:'deposit',id:fresh.id,eventId:e.id},comment:fresh.name,reserveActions:p.reserveActions,allowOverdraft:p.allowOverdraft,overdraftReason:p.overdraftReason},u);e.operationId=o.id;s.depositEvents.push(e);
        }}syncContractPlans(s);validateReserves(s);audit(s,u.id,type,d?.id||s.deposits.at(-1).id,'Условия вклада сохранены');return d?.id||s.deposits.at(-1).id;
    }
    if(type==='deposit.rate'){const d=get(s,'deposits',p.id);requireThat(d?.status==='active','Вклад не найден.');requireThat(validDate(p.date)&&p.date>today(s)&&p.date<=d.endDate,'Новую ставку задайте на будущую дату внутри срока.','date');requireThat(!d.rateIntervals.some(r=>r.date===p.date),'Для этой даты ставка уже задана.');d.rateIntervals.push({date:p.date,rate:plain(rateUnits(p.rate),6)});d.revision++;syncContractPlans(s);audit(s,u.id,type,d.id,'Новая будущая ставка вклада');return;}
    if(type.startsWith('deposit.')){
      const d=get(s,'deposits',p.id);requireThat(d,'Вклад не найден.');let prior=null;
      if(p.editEventId){prior=cancelContractEvent(s,{module:'deposit',contractId:d.id,eventId:p.editEventId,reason:p.reason},u);}
      requireThat(d.status==='active','Вклад уже закрыт.');const latest=latestContractEvent(s,'deposit',d.id);requireThat(!latest||p.date>=latest.date,'Сначала отмените более поздние события вклада.','date');requireThat(validDate(p.date)&&p.date>=f.startDate&&p.date>=d.openingDate&&p.date<=d.endDate,'Дата вне учитываемого срока вклада.','date');
      const principal=depositBalance(s,d,p.date),projection=depositProjection(s,d,p.date),currency=d.currency,w=walletActive(s,p.walletId||d.payoutWalletId),e=stamp({id:id(),contractId:d.id,type:'',date:p.date,sequence:f.revision+1,calculatedAmount:'0',actualAmount:'0',principalDelta:'0',reason:p.reason||''},u.id);requireThat(w.currency===currency,'Выберите кошелек в валюте вклада.','walletId');let op;
      if(type==='deposit.topup'||type==='deposit.withdraw'){
        const topup=type==='deposit.topup',amount=amountOf(p.amount,currency,s);requireThat(topup?d.topupAllowed:d.withdrawalAllowed,topup?'Пополнение запрещено условиями.':'Частичное снятие запрещено условиями.');requireThat(topup||amount<principal&&principal-amount>=BigInt(d.minBalance),'Снятие нарушает неснижаемый остаток; полное снятие — через закрытие.','amount');e.type=topup?'topup':'withdraw';e.principalDelta=(topup?amount:-amount).toString();e.actualAmount=amount.toString();op=contractOperation(s,{kind:topup?'deposit_topup':'deposit_withdraw',date:p.date,walletId:w.id,currency,amount,walletDelta:topup?-amount:amount,depositId:d.id,depositDelta:topup?amount:-amount,contract:{module:'deposit',id:d.id,eventId:e.id},comment:d.name,priorOperation:prior,reserveActions:p.reserveActions,allowOverdraft:p.allowOverdraft,overdraftReason:p.overdraftReason},u);
      }else if(type==='deposit.reconcile'||type==='deposit.interest'){
        const dates=depositDates(s,d),confirmed=new Set(contractEvents(s,'depositEvents',d.id).filter(e=>['interest','capitalization','close'].includes(e.type)).map(e=>e.date));const next=dates.find(date=>!confirmed.has(date));requireThat(p.date===next&&(p.date!==d.endDate||type==='deposit.reconcile'&&!p.editEventId),'Сверьте ближайшую выплату; окончание проводится через закрытие.','date');const actual=amountOf(p.actualAmount,currency,s,true),calculated=projection.accrued;
        if(type==='deposit.reconcile'&&!p.editEventId){let draft=s.depositEvents.find(e=>e.contractId===d.id&&e.date===p.date&&!e.operationId&&e.type==='reconciliation');if(!draft){draft=stamp({id:id(),contractId:d.id,type:'reconciliation',date:p.date},u.id);s.depositEvents.push(draft);}Object.assign(draft,{actualAmount:actual.toString(),calculatedAmount:calculated.toString(),reason:p.reason||'',updatedAt:now()});audit(s,u.id,type,d.id,'Сохранена сверка неподтвержденных процентов');return draft.id;}
        requireThat(p.date<=today(s),'Фактическая выплата не может быть будущей.','date');e.type=d.capitalizes?'capitalization':'interest';e.actualAmount=actual.toString();e.calculatedAmount=calculated.toString();e.principalDelta=d.capitalizes?actual.toString():'0';const initial=projection.initialLeft<actual?projection.initialLeft:actual;
        op=contractOperation(s,{kind:d.capitalizes?'deposit_capitalization':'deposit_interest',date:p.date,walletId:w.id,currency,amount:actual,walletDelta:d.capitalizes?0n:actual,depositId:d.id,depositDelta:d.capitalizes?actual:0n,incomes:[{amount:initial,origin:'before_start'},{amount:actual-initial}],contract:{module:'deposit',id:d.id,eventId:e.id},comment:d.name,priorOperation:prior,cashDirection:d.capitalizes?0:1},u);
      }else if(type==='deposit.close'){
        const early=p.date<d.endDate,calculated=early?depositEarly(s,d,p.date):null,holding=amountOf(p.withholding,currency,s,true);let amount,interest;
        if(early){amount=amountOf(p.actualReturn,currency,s,true);interest=amount-principal;requireThat(amount+holding>=principal,'Фактический возврат и удержание не согласованы.','withholding');if(amount!==calculated.returnAmount)checkText(p.reason||'',3,300,'Причина отличия от расчета','reason');}
        else {const returned=amountOf(p.returnedPrincipal,currency,s,true);requireThat(returned===principal,'Тело возврата должно совпадать с остатком; разницу укажите удержанием.','returnedPrincipal');const actualInterest=amountOf(p.actualInterest,currency,s,true);amount=returned+actualInterest-holding;interest=actualInterest-holding;requireThat(amount>=0n,'Возврат не может быть отрицательным.');}
        requireThat(p.confirmed,'Подтвердите фактический возврат и удержание банка.','confirmed');e.type='close';e.principalDelta=(-principal).toString();e.actualAmount=interest.toString();e.actualReturn=amount.toString();e.withholding=holding.toString();e.calculatedAmount=(early?calculated.adjustment:projection.accrued).toString();e.early=early;e.earlyCalculation=calculated?JSON.parse(JSON.stringify(calculated,(_,v)=>typeof v==='bigint'?v.toString():v)):null;
        const initial=interest>0n?(projection.initialLeft<interest?projection.initialLeft:interest):0n;op=contractOperation(s,{kind:'deposit_close',date:p.date,walletId:w.id,currency,amount,walletDelta:amount,depositId:d.id,depositDelta:-principal,incomes:[{amount:initial,origin:'before_start'},{amount:interest-initial}],contract:{module:'deposit',id:d.id,eventId:e.id},comment:d.name,priorOperation:prior,cashDirection:1},u);d.status='closed';
      }else throw new AppError('Неизвестное действие вклада.');
      e.operationId=op.id;s.depositEvents.push(e);const plan=s.plans.find(x=>x.contractKey===`deposit:${d.id}:${p.date}`);if(plan&&['interest','close'].includes(e.type))fulfillContractPlan(s,plan,op);syncContractPlans(s);return e.id;
    }
    if(type==='loan.save'){
      requireThat(!p.id,'Для действующего кредита используйте платежи и пересчет.');const w=walletActive(s,p.walletId),currency=w.currency;requireThat(['new','existing'].includes(p.mode),'Выберите режим кредита.');requireThat(validDate(p.openingDate)&&(p.mode==='new'?p.openingDate>=f.startDate:p.openingDate<=today(s)),'Проверьте дату выдачи кредита.','openingDate');requireThat(p.mode!=='existing'||p.openingDate<=f.startDate,'Существующий кредит выдан не позже начала учета.');
      const principal=amountOf(p.principal,currency,s),initial=amountOf(p.initialAmount||p.principal,currency,s);requireThat(initial>=principal&&(p.mode==='existing'||initial===principal),'Исходная сумма меньше остатка долга или не совпадает с новым кредитом.');const arrears=amountOf(p.openingAccruedInterest||'0',currency,s,true),past=amountOf(p.pastOverpayment||'0',currency,s,true),fee=amountOf(p.regularFee||'0',currency,s,true);rateUnits(p.annualRate);requireThat(['annuity','differentiated'].includes(p.model),'Выберите модель графика.');const day=Number(p.paymentDay);requireThat(Number.isInteger(day)&&day>=1&&day<=31&&validDate(p.firstPaymentDate)&&p.firstPaymentDate>=f.startDate&&p.firstPaymentDate>p.openingDate,'Проверьте дату первого платежа и день месяца.','firstPaymentDate');
      const rows=loanSchedule(principal,p.annualRate,Number(p.months),p.firstPaymentDate,day,p.model),l=stamp({id:id(),name:checkText(p.name,1,100,'Название','name'),lender:checkText(p.lender||'',0,100,'Кредитор','lender'),currency,mode:p.mode,openingDate:p.openingDate,initialAmount:initial.toString(),principalAtStart:principal.toString(),openingAccruedInterest:arrears.toString(),pastOverpayment:past.toString(),annualRate:plain(rateUnits(p.annualRate),6),model:p.model,months:Number(p.months),firstPaymentDate:p.firstPaymentDate,paymentDay:day,walletId:w.id,regularFee:fee.toString(),basePayment:rows[0].payment.toString(),baseBody:rows[0].principal.toString(),comment:checkText(p.comment||'',0,1000,'Комментарий','comment'),status:p.mode==='new'&&p.openingDate>today(s)?'planned':'active',scheduleVersion:0},u.id);s.loans.push(l);newLoanRows(s,l,rows);
      if(p.mode==='new'&&l.status==='active'){const e=stamp({id:id(),contractId:l.id,type:'open',date:p.openingDate,principal:'0',interest:'0',fees:'0',sequence:f.revision+1},u.id),o=contractOperation(s,{kind:'credit_received',date:p.openingDate,walletId:w.id,currency,amount:principal,walletDelta:principal,contract:{module:'loan',id:l.id,eventId:e.id},comment:l.name,cashDirection:1},u);e.operationId=o.id;s.loanEvents.push(e);}syncContractPlans(s);audit(s,u.id,type,l.id,'Добавлен кредит: '+l.name);return l.id;
    }
    if(type==='loan.receive'){
      const l=get(s,'loans',p.id);requireThat(l?.status==='planned','Кредит уже получен или отменен.');const amount=BigInt(l.principalAtStart),e=stamp({id:id(),contractId:l.id,type:'open',date:p.date,principal:'0',interest:'0',fees:'0',wasPlanned:true,sequence:f.revision+1},u.id),o=contractOperation(s,{kind:'credit_received',date:p.date,walletId:l.walletId,currency:l.currency,amount,walletDelta:amount,contract:{module:'loan',id:l.id,eventId:e.id},comment:l.name,cashDirection:1},u);e.operationId=o.id;s.loanEvents.push(e);l.status='active';const plan=s.plans.find(p=>p.contractKey==='loan-receive:'+l.id);if(plan)fulfillContractPlan(s,plan,o);syncContractPlans(s);return e.id;
    }
    if(type==='loan.pay'||type==='loan.early'){
      const l=get(s,'loans',p.id);requireThat(l,'Кредит не найден.');let prior=null;if(p.editEventId)prior=cancelContractEvent(s,{module:'loan',contractId:l.id,eventId:p.editEventId,reason:p.reason},u);requireThat(l.status==='active','Кредит закрыт.');const latest=latestContractEvent(s,'loan',l.id);requireThat(!latest||p.date>=latest.date,'Сначала отмените последующие выплаты кредита.');const st=loanState(s,l),principal=amountOf(p.principal,l.currency,s,true),interest=amountOf(p.interest,l.currency,s,true),fees=amountOf(p.fees||'0',l.currency,s,true),amount=amountOf(p.amount,l.currency,s),row=type==='loan.pay'?get(s,'loanSchedules',p.rowId):null;
      requireThat(principal+interest+fees===amount,'Тело, проценты и комиссии должны точно совпадать с общей суммой.','amount');requireThat(principal<=st.principal,'Тело платежа превышает остаток долга.','principal');requireThat(interest>=st.arrears,'Сначала включите начисленные проценты на начало учета.','interest');requireThat(type!=='loan.pay'||row?.loanId===l.id&&row.status==='planned','Строка уже оплачена или изменена.');requireThat(type!=='loan.early'||['term','payment'].includes(p.earlyMode),'Выберите уменьшение срока или платежа.');
      const changed=type==='loan.early'||principal!==BigInt(row.principal),preview=changed?loanPreview(s,l,{...p,rowId:type==='loan.pay'?p.rowId:undefined}):null;requireThat(!changed||p.previewConfirmed,'Подтвердите просмотр нового графика.','previewConfirmed');
      const e=stamp({id:id(),contractId:l.id,type:type==='loan.early'?'early':'payment',date:p.date,principal:principal.toString(),interest:interest.toString(),fees:fees.toString(),openingInterestPaid:st.arrears.toString(),rowId:row?.id||null,earlyMode:p.earlyMode||null,sequence:f.revision+1,scheduleBefore:s.loanSchedules.filter(r=>r.loanId===l.id&&r.status==='planned').map(r=>({id:r.id,status:r.status}))},u.id);
      const o=contractOperation(s,{kind:type==='loan.early'?'credit_early':'credit_payment',date:p.date,walletId:p.walletId||l.walletId,currency:l.currency,amount,walletDelta:-amount,expense:amount,expenseCategory:'credit',contract:{module:'loan',id:l.id,eventId:e.id},comment:l.name,priorOperation:prior,reserveActions:p.reserveActions,allowOverdraft:p.allowOverdraft,overdraftReason:p.overdraftReason},u);e.operationId=o.id;s.loanEvents.push(e);if(row){row.status='paid';row.actualOperationId=o.id;const plan=s.plans.find(p=>p.contractKey==='loan:'+row.id);if(plan)fulfillContractPlan(s,plan,o);}
      if(changed){for(const r of pendingLoanRows(s,l))r.status='cancelled';newLoanRows(s,l,preview.rows,e.id);}if(loanState(s,l).principal===0n&&loanState(s,l).arrears===0n){l.status='closed';for(const r of pendingLoanRows(s,l))r.status='cancelled';}syncContractPlans(s);return e.id;
    }
    if(type==='debt.save'){
      requireThat(['owe','owed'].includes(p.direction)&&['new','existing'].includes(p.mode),'Выберите направление и режим займа.');const w=walletActive(s,p.walletId),principal=amountOf(p.principal,w.currency,s);requireThat(validDate(p.openingDate)&&p.openingDate<=today(s)&&(!p.dueDate||validDate(p.dueDate)&&p.dueDate>=p.openingDate),'Проверьте даты займа.');requireThat(p.mode!=='existing'||p.openingDate<=f.startDate,'Существующий долг возник не позже начала учета.');const d=stamp({id:id(),counterparty:checkText(p.counterparty,1,100,'Контрагент','counterparty'),direction:p.direction,mode:p.mode,currency:w.currency,initialPrincipal:principal.toString(),openingDate:p.openingDate,dueDate:p.dueDate||null,walletId:w.id,expectedReturn:!!p.expectedReturn,comment:checkText(p.comment||'',0,1000,'Комментарий','comment'),status:'active'},u.id);s.personalDebts.push(d);
      if(p.mode==='new'){const incoming=d.direction==='owe',e=stamp({id:id(),contractId:d.id,type:'open',date:p.openingDate,principal:'0',interest:'0',sequence:f.revision+1},u.id),o=contractOperation(s,{kind:incoming?'debt_receive':'debt_issue',date:p.openingDate,walletId:w.id,currency:w.currency,amount:principal,walletDelta:incoming?principal:-principal,contract:{module:'debt',id:d.id,eventId:e.id},comment:d.counterparty,cashDirection:incoming?1:-1,allowOverdraft:p.allowOverdraft,overdraftReason:p.overdraftReason},u);e.operationId=o.id;s.debtEvents.push(e);}syncContractPlans(s);audit(s,u.id,type,d.id,'Добавлен личный долг');return d.id;
    }
    if(type==='debt.expectation'){const d=get(s,'personalDebts',p.id);requireThat(d?.status==='active','Долг не найден.');requireThat(!p.dueDate||validDate(p.dueDate),'Проверьте срок.');d.dueDate=p.dueDate||null;d.expectedReturn=!!p.expectedReturn;syncContractPlans(s);audit(s,u.id,type,d.id,'Ожидание возврата обновлено');return;}
    if(type==='debt.pay'){
      const d=get(s,'personalDebts',p.id);requireThat(d,'Долг не найден.');let prior=null;if(p.editEventId)prior=cancelContractEvent(s,{module:'debt',contractId:d.id,eventId:p.editEventId,reason:p.reason},u);requireThat(d.status==='active','Долг закрыт.');const last=latestContractEvent(s,'debt',d.id);requireThat(!last||p.date>=last.date,'Сначала отмените последующие возвраты.');const principal=amountOf(p.principal,d.currency,s,true),interest=amountOf(p.interest||'0',d.currency,s,true),amount=principal+interest,st=debtState(s,d);requireThat(amount>0n&&principal<=st.principal,'Сумма тела превышает остаток или выплата пуста.','principal');const incoming=d.direction==='owed',e=stamp({id:id(),contractId:d.id,type:'return',date:p.date,principal:principal.toString(),interest:interest.toString(),sequence:f.revision+1},u.id),o=contractOperation(s,{kind:'debt_return',date:p.date,walletId:p.walletId||d.walletId,currency:d.currency,amount,walletDelta:incoming?amount:-amount,incomes:incoming?[{amount:interest,categoryId:'other_income'}]:[],expense:incoming?0n:interest,expenseCategory:'other_expense',contract:{module:'debt',id:d.id,eventId:e.id},comment:d.counterparty,cashDirection:incoming?1:-1,priorOperation:prior,reserveActions:p.reserveActions,allowOverdraft:p.allowOverdraft,overdraftReason:p.overdraftReason},u);e.operationId=o.id;s.debtEvents.push(e);const plan=s.plans.find(row=>row.contractKey==='debt:'+d.id);if(plan&&principal){s.planLinks.push(stamp({id:id(),planId:plan.id,operationId:o.id,appliedAmountInPlanCurrency:principal.toString(),coveredAmount:'0',finalize:principal===st.principal,status:'active'},u.id));o.links.planId=plan.id;}if(debtState(s,d).principal===0n)d.status='closed';syncContractPlans(s);return e.id;
    }
    throw new AppError('Неизвестное действие договора.');
  }
  function execute(s,type,p,u) {
    const f=family(s);
    if(/^(deposit|loan|debt|contract)\./.test(type))return executeContracts(s,type,p,u);
    if(type==='plan.request'){
      requireThat(['editor','contributor'].includes(u.role),'Запрос доступен участнику.','','FORBIDDEN');const plan=get(s,'plans',p.id);requireThat(plan&&!plan.module,'Обычный план не найден.');checkText(p.reason,3,300,'Причина','reason');s.proposals.push(stamp({id:id(),authorId:u.id,type:'plan',targetId:plan.id,targetRevision:plan.revision,payload:{planId:plan.id,reason:p.reason},reason:p.reason,status:'pending'},u.id));audit(s,u.id,type,plan.id,'Запрос изменения плана: '+p.reason);return;
    }
    if(type.startsWith('plan.')||type.startsWith('series.')||type.startsWith('goal.')||type==='limit.save'||type==='planning.settings'||type==='planning.reconcile')return executePlanning(s,type,p,u);
    if(type==='operation.save') {
      requireThat(u.role!=='viewer','Наблюдатель не может добавлять записи.','','FORBIDDEN');
      if(u.role==='contributor'){
        requireThat(['income','expense','refund'].includes(p.kind),'Для перевода недостаточно прав.','','FORBIDDEN');requireThat(!p.editId,'Используйте запрос на исправление.');buildOperation(clone(s),p,u);
        const proposal=stamp({id:id(),authorId:u.id,type:'create',payload:clone(p),status:'pending'},u.id);s.proposals.push(proposal);audit(s,u.id,'proposal.create',proposal.id,'Запись отправлена на подтверждение');return proposal.id;
      }
      needWrite(u);if(p.editId)requireThat(get(s,'operations',p.editId)?.status==='posted','Исходная запись изменена. Обновите форму.','','CONFLICT');return saveOperation(s,p,u,p.editId?get(s,'operations',p.editId):null);
    }
    if(type==='operation.cancel'){needWrite(u);return cancelOperation(s,p.id,u,p.reason,p.allowOverdraft,p.overdraftReason);}
    if(type==='proposal.request'){
      requireThat(u.role!=='viewer','Недостаточно прав.','','FORBIDDEN');const o=get(s,'operations',p.targetId);requireThat(!o?.links?.contract,'Договорные операции изменяет владелец из договора.');requireThat(o?.status==='posted','Запись уже изменена.','','CONFLICT');checkText(p.reason,3,300,'Причина запроса','reason');
      requireThat(['edit','cancel'].includes(p.requestType),'Неверный запрос.');s.proposals.push(stamp({id:id(),authorId:u.id,type:p.requestType,targetId:o.id,targetRevision:o.revision,payload:clone(p.payload||{}),reason:p.reason,status:'pending'},u.id));audit(s,u.id,'proposal.request',o.id,'Запрос владельцу: '+p.reason);return;
    }
    if(type==='proposal.edit'){
      const q=get(s,'proposals',p.id);requireThat(q?.status==='pending'&&q.authorId===u.id&&q.type==='create','Эту заявку нельзя изменить.');requireThat(['income','expense','refund'].includes(p.payload.kind),'Недопустимый тип заявки.');buildOperation(clone(s),p.payload,u);q.payload=clone(p.payload);q.updatedAt=now();q.revision++;audit(s,u.id,type,q.id,'Ожидающая заявка исправлена');return;
    }
    if(type==='proposal.withdraw'){const q=get(s,'proposals',p.id);requireThat(q?.status==='pending'&&q.authorId===u.id,'Нельзя отозвать эту заявку.');q.status='withdrawn';audit(s,u.id,'proposal.withdraw',q.id,'Заявка отозвана');return;}
    if(type==='proposal.decide'){
      needOwner(u);const q=get(s,'proposals',p.id);requireThat(q?.status==='pending','Заявка уже рассмотрена.','','CONFLICT');
      if(p.approve){const payload=p.payload||q.payload;let result;
        if(q.type==='plan'){const target=get(s,'plans',q.targetId);requireThat(target?.revision===q.targetRevision,'План уже изменен. Отклоните устаревший запрос.');result=executePlanning(s,'plan.save',{...payload,id:target.id},u);}
        else if(q.type==='create')result=saveOperation(s,payload,u,null,q.authorId);
        else {const target=get(s,'operations',q.targetId);requireThat(target?.status==='posted'&&target.revision===q.targetRevision,'Исходная запись изменилась. Отклоните устаревший запрос.','','CONFLICT');if(q.type==='cancel')result=cancelOperation(s,target.id,u,q.reason,payload.allowOverdraft,payload.overdraftReason);else result=saveOperation(s,{...payload,reason:q.reason},u,target);}
        q.status='approved';q.resultingOperationId=result;
      }else{checkText(p.reason||'',3,300,'Причина отклонения','reason');q.status='rejected';q.decisionReason=p.reason;}
      q.decisionBy=u.id;q.decisionAt=now();audit(s,u.id,'proposal.decide',q.id,p.approve?'Заявка одобрена':'Заявка отклонена',{reason:p.reason||'',revisionRefs:q.resultingOperationId?[q.resultingOperationId]:null});return;
    }
    if(type==='profile.password'){
      requireThat(/^[0-9a-f]{64}$/.test(p.hash?.passwordHash||'')&&/^[0-9a-f]{32}$/.test(p.hash?.passwordSalt||'')&&p.hash?.passwordIterations===600000,'Некорректные параметры пароля.');
      const target=get(s,'users',p.userId||u.id);requireThat(target,'Профиль не найден.');requireThat(target.id===u.id||u.role==='owner','Недостаточно прав.','','FORBIDDEN');requireThat(target.id===u.id||target.role!=='owner','Нельзя сбросить пароль владельца.');
      const proof=passwordProofs.get(u.id);requireThat(target.id!==u.id||(proof?.nonce===p.verificationProof&&proof?.authVersion===u.authVersion),'Подтвердите текущий пароль.','oldPassword');Object.assign(target,p.hash);target.authVersion++;target.mustChangePassword=target.id!==u.id;target.updatedAt=now();audit(s,u.id,'profile.password',target.id,'Пароль профиля изменен');return target.authVersion;
    }
    if(type==='profile.theme'){u.preferences={...u.preferences,theme:p.theme==='dark'?'dark':'light'};return;}
    needOwner(u);
    if(type==='family.save'){
      const name=checkText(p.name,1,80,'Название семьи','name');requireThat(validDate(p.startDate),'Выберите дату начала.','startDate');try{new Intl.DateTimeFormat('ru',{timeZone:p.timezone});}catch{throw new AppError('Неизвестный часовой пояс.','timezone');}
      requireThat(!s.operations.length||(p.startDate===f.startDate&&p.timezone===f.timezone),'После первой операции дата и часовой пояс неизменны.');
      const changedFields={};for(const k of ['name','startDate','timezone'])if(f[k]!==p[k])changedFields[k]={before:f[k],after:p[k]};Object.assign(f,{name,startDate:p.startDate,timezone:p.timezone});audit(s,u.id,type,f.id,'Настройки семьи изменены',{changedFields});return;
    }
    if(type==='member.save'){const member=f.members.find(m=>m.id===p.id);const name=checkText(p.name,1,50,'Имя','name');if(member)member.name=name;else f.members.push({id:id(),name});audit(s,u.id,type,p.id||f.id,'Пометка члена семьи: '+name);return;}
    if(type==='wallet.save'){
      const w=p.id?get(s,'wallets',p.id):null,name=checkText(p.name,1,60,'Название кошелька','name');requireThat(!s.wallets.some(x=>!x.archived&&x.id!==p.id&&x.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')),'Такое название уже есть.','name');requireThat(WALLET[p.type],'Выберите тип счета.','type');requireThat(get(s,'currencies',p.currency),'Выберите валюту.','currency');
      const used=w&&s.postings.some(x=>x.accountId===w.id);requireThat(!used||w.currency===p.currency,'Валюту счета с историей менять нельзя.','currency');const amount=amountOf(p.openingBalance,p.currency,s,true);
      const before=clone(s);if(w&&w.openingBalance!==amount.toString())checkText(p.reason||'',3,300,'Причина изменения начального остатка','reason');
      const row={id:w?.id||id(),familyId:f.id,name,type:p.type,currency:p.currency,openingBalance:amount.toString(),liquid:!!p.liquid,primaryForCurrency:!!p.primaryForCurrency,archived:w?.archived||false,comment:(p.comment||'').slice(0,1000)};
      if(w)Object.assign(w,row,{updatedAt:now(),revision:w.revision+1});else s.wallets.push(stamp(row,u.id));
      if(p.primaryForCurrency)for(const other of s.wallets)if(other.id!==row.id&&other.currency===p.currency)other.primaryForCurrency=false;
      requireThat(!w||!s.reserveEvents.some(e=>e.walletId===w.id)||w.currency===p.currency,'Валюту счета с резервами менять нельзя.');validateBalances(before,s,false);validateReserves(s);audit(s,u.id,type,row.id,w?'Кошелек изменен: '+name:'Добавлен кошелек: '+name,{reason:p.reason||''});return row.id;
    }
    if(type==='wallet.archive'){const w=get(s,'wallets',p.id);requireThat(w,'Счет не найден.');requireThat(w.archived||balances(s)[w.id]===0n,'Сначала обнулите остаток счета.');if(w.archived)requireThat(!s.wallets.some(x=>!x.archived&&x.id!==w.id&&x.name.toLocaleLowerCase('ru')===w.name.toLocaleLowerCase('ru')),'Такое название уже есть у активного кошелька. Сначала переименуйте его.');w.archived=!w.archived;audit(s,u.id,type,w.id,w.archived?'Кошелек в архиве':'Кошелек восстановлен');return;}
    if(type==='currency.save'){const code=String(p.code||'').trim().toUpperCase();requireThat(/^[A-Z0-9]{2,12}$/.test(code),'Код валюты: 2–12 латинских букв или цифр.','code');requireThat(!get(s,'currencies',code),'Эта валюта уже добавлена.','code');requireThat(Number.isInteger(p.decimals)&&p.decimals>=0&&p.decimals<=18,'Точность: целое число от 0 до 18.','decimals');s.currencies.push({id:code,code,displayName:checkText(p.displayName,1,50,'Название','displayName'),decimals:p.decimals,kind:p.kind==='crypto'?'crypto':'fiat',active:true});audit(s,u.id,type,code,'Добавлена валюта '+code);return;}
    if(type==='rate.save'){requireThat(p.currency!=='RUB'&&get(s,'currencies',p.currency),'Выберите валюту, отличную от RUB.','currency');requireThat(validDate(p.date),'Укажите дату курса.','date');parseMoney(p.rate,12);const existing=s.rates.find(x=>x.currency===p.currency&&x.effectiveDate===p.date);const row={id:existing?.id||id(),currency:p.currency,effectiveDate:p.date,rubPerUnit:p.rate.replace(',','.'),enteredAt:now(),enteredBy:u.id};if(existing)Object.assign(existing,row);else s.rates.push(stamp(row,u.id));audit(s,u.id,type,row.id,`Курс ${p.currency}: ${row.rubPerUnit} RUB`);return;}
    if(type==='category.save'){const c=p.id?get(s,'categories',p.id):null;requireThat(!c?.locked,'Системную категорию нельзя изменять.');requireThat(['income','expense'].includes(p.type),'Выберите тип категории.','type');const name=checkText(p.name,1,60,'Название категории','name');requireThat(!s.categories.some(x=>x.id!==p.id&&x.type===p.type&&x.name.toLowerCase()===name.toLowerCase()),'Такая категория уже есть.','name');requireThat(!c||c.type===p.type,'Тип существующей категории неизменен.','type');const row={name,type:p.type,color:PALETTE.includes(p.color)?p.color:PALETTE[0]};if(c)Object.assign(c,row);else s.categories.push(stamp({id:id(),...row,systemCode:null,archived:false},u.id));audit(s,u.id,type,p.id||name,'Категория: '+name);return;}
    if(type==='category.archive'){const c=get(s,'categories',p.id);requireThat(c&&!c.locked,'Системная категория нужна для учета.');c.archived=!c.archived;audit(s,u.id,type,c.id,c.archived?'Категория в архиве':'Категория восстановлена');return;}
    if(type==='category.delete'){const c=get(s,'categories',p.id);requireThat(c&&!c.systemCode,'Удалить можно только свою неиспользованную категорию.');requireThat(!s.expenseLines.some(x=>x.categoryId===c.id)&&!s.operations.some(x=>x.categoryId===c.id)&&!s.proposals.some(x=>JSON.stringify(x.payload).includes(c.id))&&!s.plans.some(x=>x.categoryId===c.id)&&!s.limits.some(x=>x.categoryId===c.id),'Категория использована: отправьте ее в архив.');s.categories=s.categories.filter(x=>x.id!==c.id);audit(s,u.id,type,c.id,'Категория удалена: '+c.name);return;}
    if(type==='user.save'){
      const target=p.id?get(s,'users',p.id):null;checkLogin(p.login);const normalized=loginName(p.login);requireThat(!s.users.some(x=>x.id!==p.id&&x.loginNormalized===normalized),'Логин уже занят.','login');const displayName=checkText(p.displayName,1,50,'Имя','displayName');requireThat(target?.role==='owner'?p.role==='owner':['editor','contributor','viewer'].includes(p.role),'Выберите роль.','role');
      if(target){requireThat(target.role!=='owner'||p.status==='active','Нельзя блокировать владельца.');Object.assign(target,{displayName,loginNormalized:normalized,role:p.role,status:p.status==='blocked'?'blocked':'active',updatedAt:now()});}
      else{requireThat(p.hash,'Задайте пароль.');s.users.push(stamp({id:id(),displayName,loginNormalized:normalized,role:p.role,status:'active',...p.hash,authVersion:1,mustChangePassword:true,preferences:{theme:'light'}},u.id));}
      audit(s,u.id,type,target?.id||normalized,'Профиль: '+displayName);return;
    }
    throw new AppError('Неизвестная команда.');
  }
  async function command(type,p={},opts={}) {
    const expected=opts.expectedRevision??family(data)?.revision,commandId=opts.commandId||id();
    const result=await transaction(s=>{
      const saved=metaGet(s,'command:'+commandId);if(saved)return saved.result;
      const u=ensureActor(s);requireThat(!u.mustChangePassword||type==='profile.password','Сначала смените временный пароль.','','FORBIDDEN');requireThat(family(s).revision===expected,'Данные изменились в другой вкладке. Обновите форму и проверьте значения.','','CONFLICT');
      const before=type==='planning.reconcile'?JSON.stringify([s.plans,s.operations,s.postings,s.reserveEvents]):null;
      const result=execute(s,type,p,u);if(before!==null&&before===JSON.stringify([s.plans,s.operations,s.postings,s.reserveEvents]))return result;
      family(s).revision++;family(s).updatedAt=now();metaSet(s,'command:'+commandId,{result:result??null,timestamp:now()});return result;
    });
    if(type==='profile.password'&&(!p.userId||p.userId===session.id))session.authVersion=result;
    await refresh();broadcast();return result;
  }
  async function register(p){
    checkLogin(p.login);checkPassword(p.password,p.confirmPassword);requireThat(validDate(p.startDate),'Выберите дату начала учета.','startDate');
    const displayName=String(p.login).trim(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'Europe/Moscow';
    const hash=await passwordHash(p.password),uid=id();
    await transaction(s=>{requireThat(!s.family.length,'Семья уже создана в другой вкладке. Обновите страницу.','','CONFLICT');
      s.currencies=baseCurrencies();s.categories=baseCategories();s.users.push(stamp({id:uid,loginNormalized:loginName(p.login),displayName,role:'owner',status:'active',...hash,authVersion:1,mustChangePassword:false,preferences:{theme:document.documentElement.dataset.theme||'light'}},uid));
      s.family.push(stamp({id:'family',name:'Мой бюджет',startDate:p.startDate,timezone,baseCurrency:'RUB',initialized:true,revision:1,investmentInterests:[],members:[{id:'self',name:'Мне'},{id:'partner',name:'Муж'},{id:'child',name:'Ребенок'}]},uid));
      audit(s,uid,'family.create','family','Создан семейный бюджет');
    });
    session={id:uid,authVersion:1};lastActivity=Date.now();await refresh();broadcast();await reconcile();
    try{await navigator.storage?.persist?.();}catch{/* Persistence refusal does not affect correctness. */}
  }
  function broadcast(){if(channel)channel.postMessage('changed');else try{localStorage.setItem('moneyByPlan:changed',id());}catch{/* Signals are optional. */}}
  async function refresh(){data=await readAll();if(session){const current=get(data,'users',session.id);if(!current||current.status!=='active'||current.authVersion!==session.authVersion){session=null;closeDialog(true);toast('Профиль заблокирован или пароль изменен. Войдите заново.',true);}}render();}
  function applyTheme(theme){document.documentElement.dataset.theme=theme;try{localStorage.setItem('moneyByPlan:theme',theme);}catch{/* Preference only. */}}
  async function toggleTheme(){const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';applyTheme(theme);if(session)try{await command('profile.theme',{theme});}catch(e){toast(e.message,true);}}
  function toast(message,error=false){const node=document.getElementById('toast');node.textContent=message;node.className='toast'+(error?' error':'');node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,6500);}
  function lock(){if(!session)return;session=null;passwordProofs.clear();closeDialog(true);render();}
  function fatal(message){document.getElementById('app').replaceChildren(el('div',{class:'boot'},el('h1',{},'Не удалось открыть бюджет'),el('span',{},message),el('p',{class:'hint'},'Открывайте страницу через localhost или HTTPS. Данные не удалялись.'),button('Попробовать снова',()=>location.reload(),'primary')));}

  /* UI is defined below. All writes go through command(), never from render functions. */
  function field(label,name,value='',options={}) {
    const {choices,hint,...attrs}=options;
    let control;
    if(choices)control=el('select',{name,...attrs},choices.map(item=>el('option',{value:typeof item==='string'?item:item[0]},typeof item==='string'?item:item[1])));
    else if(attrs.type==='textarea'){delete attrs.type;control=el('textarea',{name,...attrs});}
    else control=el('input',{name,type:'text',...attrs});
    control.value=value??'';
    return el('label',{class:'field'},el('span',{},label),control,hint?el('span',{class:'field-hint'},hint):null,el('span',{class:'field-error','data-error-for':name}));
  }
  const check = (label,name,value=false) => el('label',{class:'check'},el('input',{type:'checkbox',name,checked:value}),el('span',{},label));
  const formValue = (form,name) => form.elements.namedItem(name)?.value??'';
  const formCheck = (form,name) => !!form.elements.namedItem(name)?.checked;
  const values = form => Object.fromEntries(new FormData(form));
  const optionsWallets = (currency=null) => data.wallets.filter(w=>!w.archived&&(!currency||w.currency===currency)).map(w=>[w.id,`${w.name} · ${w.currency}`]);
  const optionsCategories = (type,include=null) => data.categories.filter(c=>c.type===type&&(!c.archived||c.id===include)).map(c=>[c.id,c.name+(c.archived?' · архив':'')]);
  const members = () => [['','Вся семья'],...(family(data)?.members||[]).map(m=>[m.id,m.name])];
  const memberName = key => family(data).members.find(x=>x.id===key)?.name||'Вся семья';
  const personName = key => get(data,'users',key)?.displayName||'Система';
  const categoryName = key => get(data,'categories',key)?.name||'Без категории';
  function showFormError(form,error) {
    for(const n of form.querySelectorAll('[aria-invalid]'))n.removeAttribute('aria-invalid');for(const n of form.querySelectorAll('.field-error'))n.textContent='';
    const box=form.querySelector('.form-error');box.replaceChildren(document.createTextNode(error.message||'Не удалось выполнить действие. Повторите попытку.'));
    const input=form.elements.namedItem(error.field);
    if(input instanceof HTMLElement){input.setAttribute('aria-invalid','true');const note=input.closest('.field')?.querySelector('.field-error');if(note)note.textContent=error.message;input.focus();}
    if(error.code==='CONFLICT')box.append(el('br'),button('Обновить данные формы',async()=>{await refresh();if(modal){modal.revision=family(data).revision;box.textContent='Данные обновлены. Проверьте суммы и повторите сохранение.';}},'small'));
  }
  function closeDialog(force=false){
    if(!modal)return true;
    if(modal.required&&!force){toast('Сначала смените временный пароль.',true);return false;}
    if(modal.dirty&&!force&&!confirm('Закрыть форму без сохранения изменений?'))return false;
    const previous=modal.restoreFocus;modal.node.close();modal.node.remove();modal=null;if(previous?.isConnected)previous.focus();return true;
  }
  function openForm(title,subtitle,build,onSubmit,saveLabel='Сохранить',opts={}) {
    if(modal&&!closeDialog())return;
    const dialog=el('dialog',{'aria-labelledby':'dialog-title'}),form=el('form',{class:'dialog-form',novalidate:true}),body=el('div',{class:'dialog-body'}),error=el('div',{class:'form-error',role:'alert','aria-live':'assertive'});
    const heading=el('div',{class:'dialog-head'},el('div',{},el('h2',{id:'dialog-title'},title),el('p',{class:'hint'},subtitle)),opts.required?null:button('×',()=>closeDialog(),'icon quiet',{'aria-label':'Закрыть форму'}));
    body.append(error);const footer=el('div',{class:'dialog-foot'},opts.required?null:button(saveLabel?'Отмена':'Закрыть',()=>closeDialog(),'quiet'));
    const submit=saveLabel?el('button',{type:'submit',class:'primary'},saveLabel):null;if(submit)footer.append(submit);
    form.append(heading,body,footer);dialog.append(form);document.body.append(dialog);
    modal={node:dialog,form,revision:family(data)?.revision,commandId:id(),dirty:false,required:!!opts.required,restoreFocus:document.activeElement};
    build(body,form);
    form.addEventListener('input',()=>{if(modal)modal.dirty=true;});form.addEventListener('change',()=>{if(modal)modal.dirty=true;});
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
    form.addEventListener('submit',async event=>{event.preventDefault();if(!onSubmit||submit?.disabled)return;const current=modal;if(submit){submit.disabled=true;submit.textContent='Сохраняем…';}
      error.textContent='';try{const message=await onSubmit(form,{expectedRevision:current.revision,commandId:current.commandId});closeDialog(true);if(message)toast(message);}catch(e){if(e.code==='SESSION'){lock();toast(e.message,true);}else showFormError(form,e);}finally{if(submit){submit.disabled=false;submit.textContent=saveLabel;}}
    });
    dialog.showModal();return form;
  }
  async function run(type,p,message){try{await command(type,p);if(message)toast(message);}catch(e){if(e.code==='SESSION')lock();toast(e.message,true);}}
  function header(title,description,actions=[]){return el('div',{class:'page-heading'},el('div',{},el('h1',{},title),el('p',{},description)),el('div',{class:'row wrap'},actions));}
  function empty(title,text,action){return el('div',{class:'empty'},el('span',{class:'empty-symbol','aria-hidden':'true'},'◎'),el('h3',{},title),el('p',{},text),action);}
  function badge(text,kind=''){return el('span',{class:'badge '+kind},text);}
  function navigate(next){view=next;location.hash=next;render();}
  function render(){
    if(!data)return;
    if(!session){renderAuth();return;}
    const u=user();if(!u){session=null;renderAuth();return;}
    const valid=['overview','operations','wallets','planning','goals','deposits','loans','debts','settings'];if(!valid.includes(view))view='overview';
    const root=document.getElementById('app'),nav=[['overview','Обзор','◫'],['operations','Операции','⇄'],['wallets','Кошельки','▣'],['planning','Планирование','▦'],['goals','Цели','◎'],['deposits','Вклады','◇'],['loans','Кредиты','◴'],['debts','Личные долги','⇌'],['settings','Настройки','⚙']];
    const sidebar=el('aside',{class:'sidebar'},brand(),el('p',{class:'eyebrow space-label'},'Семейный бюджет'),el('nav',{class:'nav','aria-label':'Главная навигация'},nav.map(([key,label,symbol])=>button([el('span',{class:'nav-symbol','aria-hidden':'true'},symbol),label],()=>navigate(key),view===key?'active':'',{'aria-current':view===key?'page':null}))),el('div',{class:'sidebar-foot'},el('div',{},el('span',{class:'local-dot'}),'Данные в этом браузере'),el('div',{},'Одно семейное пространство')));
    const topbar=el('header',{class:'topbar'},el('div',{},el('div',{class:'family-name'},'Мой бюджет'),el('div',{class:'top-date'},new Intl.DateTimeFormat('ru-RU',{timeZone:family(data).timezone,day:'numeric',month:'long',year:'numeric'}).format(new Date()))),el('div',{class:'row'},el('div',{class:'avatar','aria-hidden':'true'},u.displayName[0].toUpperCase()),el('div',{class:'profile-block'},el('div',{class:'profile-name'},u.displayName),el('div',{class:'profile-role'},ROLE[u.role])),button(document.documentElement.dataset.theme==='dark'?'☀':'☾',toggleTheme,'icon quiet',{'aria-label':'Переключить тему'}),button('Заблокировать',lock,'small quiet'),button('Выйти',lock,'small quiet')));
    const main=el('main',{class:'main',id:'main'});root.replaceChildren(el('div',{class:'layout'},sidebar,el('div',{class:'workspace'},topbar,main)));
    if(family(data).startDate>today(data))main.append(el('div',{class:'notice warning'},`Подготовка к началу учета ${formatDate(family(data).startDate)}. Можно настроить кошельки; фактические операции станут доступны в выбранный день.`));
    const negatives=data.wallets.filter(w=>(balances(data)[w.id]||0n)<0n);if(negatives.length)main.append(el('div',{class:'notice error'},'Отрицательный остаток: '+negatives.map(w=>`${w.name} (${money(balances(data)[w.id],w.currency)})`).join(', ')));
    if(view==='overview')renderOverview(main);if(view==='operations')renderOperations(main);if(view==='wallets')renderWallets(main);if(view==='settings')renderSettings(main);if(view==='planning')renderPlanning(main);if(view==='goals')renderGoals(main);if(view==='deposits')renderDeposits(main);if(view==='loans')renderLoans(main);if(view==='debts')renderDebts(main);
  }
  function brand(){return el('div',{class:'brand'},el('span',{class:'brand-mark','aria-hidden':'true'},'↗'),el('span',{},'Деньги',el('br'),'по плану'));}
  function renderAuth(){
    const setup=!data.family.length;
    const visual=el('div',{class:'auth-visual','aria-hidden':'true'},el('div',{class:'visual-caption'},el('span',{class:'visual-orbit'},'◎'),'Место для ваших решений'),el('div',{class:'visual-title'},'У каждого рубля',el('br'),'есть свой план.'),el('div',{class:'visual-flow'},el('span',{class:'visual-chip'},'↗ Поступления'),el('span',{class:'visual-chip warm'},'↘ Расходы')),el('div',{class:'visual-track'},el('i'),el('i'),el('i'),el('i'),el('i'),el('i'),el('i')));
    const story=el('section',{class:'auth-story'},brand(),el('div',{class:'auth-message'},el('div',{class:'eyebrow'},'Деньги. Решения. Спокойствие.'),el('h1',{},'О деньгах —',el('br'),el('em',{},'понятнее.')),el('p',{},'Все счета, доходы и расходы — в одной картине. Чтобы управлять деньгами было легче.'),visual),el('div',{class:'auth-points'},el('div',{},el('strong',{},'01 / Общая картина'),'Сколько есть и куда уходит'),el('div',{},el('strong',{},'02 / Ваш порядок'),'Удобный учет для семьи')));
    const form=el('form',{class:'auth-form',novalidate:true},el('div',{class:'eyebrow'},setup?'Начнем с простого':'С возвращением'),el('h2',{},setup?'Создать бюджет':'Войти в бюджет'),el('p',{class:'muted'},setup?'Выберите дату начала и создайте доступ. Счета и деньги добавите уже внутри.':'Откройте свой бюджет и продолжайте с того места, где остановились.'),el('div',{class:'form-error',role:'alert','aria-live':'assertive'}));
    if(setup)form.append(field('Логин *','login','',{autocomplete:'username',maxlength:40,placeholder:'Например, anna',hint:'Латиница, от 3 символов.'}),field('Пароль *','password','',{type:'password',autocomplete:'new-password',hint:'От 8 символов.'}),field('Повторите пароль *','confirmPassword','',{type:'password',autocomplete:'new-password'}),field('Дата начала учета *','startDate','',{type:'date',min:'1900-01-01',max:'2200-12-31',hint:'День, с которого вы хотите считать свои деньги.'}));
    else form.append(field('Логин','login','',{autocomplete:'username'}),field('Пароль','password','',{type:'password',autocomplete:'current-password'}));
    const submit=el('button',{type:'submit',class:'primary'},setup?'Открыть мой бюджет →':'Войти');form.append(submit,el('p',{class:'hint auth-privacy'},setup?'Данные останутся в этом браузере. Сохраните пароль: удаленного восстановления пока нет.':'Ваши данные сохранены в этом браузере.'));
    form.addEventListener('submit',async event=>{event.preventDefault();if(submit.disabled)return;submit.disabled=true;const label=submit.textContent;submit.textContent=setup?'Создаем бюджет…':'Проверяем…';try{const p=values(form);if(setup)await register(p);else await login(p.login,p.password);}catch(e){showFormError(form,e);}finally{submit.disabled=false;submit.textContent=label;}});
    document.getElementById('app').replaceChildren(el('div',{class:'auth-layout'},story,el('section',{class:'auth-panel'},button(document.documentElement.dataset.theme==='dark'?'Светлая тема':'Темная тема',()=>{toggleTheme();renderAuth();},'small quiet auth-theme'),form)));
  }
  const formatDate = date => validDate(date)?new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')):date;
  function totalText(t){return [t.missing.length?el('span',{class:'balance-note'},'Известная часть'):null,el('span',{class:'money'},money(t.known))];}
  function renderOverview(main){
    main.append(header('Все деньги — перед вами','Текущие остатки и последние движения семейного бюджета.',canSubmit()?[button('+ Добавить операцию',()=>operationDialog('expense'),'primary')]:[]));
    const all=total(data),b=budgetInfo(data),sums=balances(data),month=today(data).slice(0,7)+'-01',stats=statistics(data,month);
    if(all.missing.length)main.append(el('div',{class:'notice warning'},'Итог неполный: нет курса для '+all.missing.map(x=>money(x.amount,x.currency)).join(', ')+'. Укажите ручной курс в настройках.'));
    const breakdown=el('details',{},el('summary',{},'Из чего складывается баланс'),el('div',{class:'breakdown'},data.wallets.filter(w=>!w.archived).map(w=>el('div',{class:'row between'},el('span',{},w.name),el('span',{class:'money'},money(sums[w.id],w.currency))))));
    for(const d of data.deposits.filter(d=>depositBalance(data,d)))breakdown.querySelector('.breakdown').append(el('div',{class:'row between'},el('span',{},d.name+' · вклад'),el('span',{class:'money'},money(depositBalance(data,d),d.currency))));
    for(const code of [...new Set(data.wallets.filter(w=>w.currency!=='RUB'&&sums[w.id]).map(w=>w.currency))]){const rate=data.rates.filter(r=>r.currency===code&&r.effectiveDate<=today(data)).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0];breakdown.querySelector('.breakdown').append(el('p',{class:'hint'},rate?`Оценка: 1 ${code} = ${rate.rubPerUnit} RUB · курс от ${formatDate(rate.effectiveDate)}`:`Нет ручного курса ${code}.`));}
    const detail=el('details',{class:'available-details'},el('summary',{},'Как рассчитана сумма'),el('div',{class:'breakdown'},[
      ['Доступные кошельки · L',b.L],['Резервы целей · −R',-b.R],['Остатки планов без покрытия · −O',-b.O],['Еще отложить в этом месяце · −G',-b.G],['Свободно сейчас · L − R',b.free],['При получении ожидаемых доходов',b.A+b.E]
    ].map(([label,a])=>el('div',{class:'row between'},el('span',{},label),el('strong',{class:'money'},money(a)))),el('p',{class:'hint'},'Будущие доходы — сценарий, не доступные сейчас деньги. Лимиты не вычитаются повторно.'),b.overdueIncome?el('p',{class:'hint warning-text'},'Срок получения части доходов прошел.'):null,
      el('div',{class:'form-section'},'Резервы'),Object.entries(reserveBalances(data)).filter(([,a])=>a>0n).map(([key,a])=>{const [gid,wid]=key.split('|'),w=get(data,'wallets',wid);return el('div',{class:'row between'},el('span',{},get(data,'goals',gid)?.name+' · '+w.name+(w.liquid?'':' · вне L')),el('span',{class:'money'},money(a,w.currency)));}),el('div',{class:'form-section'},'Ожидаемые платежи'),data.plans.filter(p=>p.kind==='expense'&&p.date<=monthEnd(today(data))&&planState(data,p).remaining).map(p=>el('div',{class:'row between'},el('span',{},p.comment||categoryName(p.categoryId)),el('span',{class:'money'},money(planState(data,p).remaining,p.currency)),button('Открыть',()=>planDetails(p),'link'))),el('div',{class:'form-section'},'План целей на месяц'),data.goals.filter(g=>g.status==='active').map(g=>el('div',{class:'row between'},el('span',{},g.name),el('span',{class:'money'},money(goalInfo(data,g).left,g.currency))))));
    const parts=detail.querySelector('.breakdown');parts.append(el('div',{class:'breakdown'},el('div',{class:'form-section'},'Доступные кошельки · L'),data.wallets.filter(w=>w.liquid&&!w.archived).map(w=>el('div',{class:'row between'},el('span',{},w.name),el('span',{class:'money'},money(sums[w.id],w.currency)))),el('div',{class:'form-section'},'Ожидаемые доходы · сценарий E'),data.plans.filter(p=>p.kind==='income'&&p.date<=monthEnd(today(data))&&get(data,'wallets',p.walletId)?.liquid&&planState(data,p).remaining).map(p=>el('div',{class:'row between'},el('span',{},(p.comment||categoryName(p.categoryId))+(p.date<today(data)?' · срок получения прошел':'')),el('span',{class:'money'},money(planState(data,p).remaining,p.currency))))));
    main.append(el('div',{class:'cards-two'},el('section',{class:'card balance-card main-balance'},el('div',{class:'balance-label'},'Общий баланс'),el('div',{class:'balance-value','data-testid':'total-balance'},totalText(all)),el('p',{class:'hint'},'Сейчас, активы без вычета долгов'),breakdown),el('section',{class:'card balance-card'},el('div',{class:'balance-label'},'Можно потратить'),el('div',{class:'balance-value','data-testid':'available-balance'},b.missing?el('span',{class:'balance-note'},'Неполный расчет · нет всех курсов'):null,b.A<0n?'Не хватает '+money(-b.A):money(b.A)),el('p',{class:'hint'},'До конца текущего месяца, без будущих поступлений'),button('Как рассчитана сумма',()=>{detail.open=true;openForm('Можно потратить','Доступные деньги за вычетом резервов и оставшихся ожиданий.',body=>body.append(detail),null,null);},'link available-trigger'))));
    main.append(el('div',{class:'metric-grid'},metric('Доходы за месяц',money(stats.income),'positive'),metric('Расходы за месяц',money(stats.expense),'negative'),metric('Разница доходов и расходов',money(stats.income-stats.expense),'')));
    if(stats.missing)main.append(el('p',{class:'hint'},'Суммы за месяц неполные: у части записей нет исторического курса.'));
    renderPlanningSummary(main);
    const recent=latestOperations().filter(o=>o.status==='posted').slice(0,5),list=el('section',{class:'card table-card'},el('div',{class:'section-head table-top'},el('h2',{},'Последние операции'),button('Все операции →',()=>navigate('operations'),'link')),recent.length?operationTable(recent,true):empty('История начинается здесь','Добавьте первое поступление или расход — они появятся в этом списке.',canSubmit()?button('Добавить запись',()=>operationDialog('expense'),'small'):null));
    const walletList=el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},'Кошельки'),button('Открыть →',()=>navigate('wallets'),'link')));
    if(!data.wallets.length)walletList.append(empty('С каких денег начнем?','Добавьте карту, наличные или валютный счет и укажите, сколько на нем было в день начала учета.',owner()?button('Добавить кошелек',()=>walletDialog(),'small'):null));
    for(const w of data.wallets.filter(x=>!x.archived).slice(0,5))walletList.append(el('div',{class:'wallet-mini'},el('span',{class:'wallet-symbol','aria-hidden':'true'},w.type==='cash'?'◈':'▣'),el('div',{class:'grow'},el('div',{class:'wallet-name'},w.name),el('div',{class:'wallet-kind'},WALLET[w.type])),el('strong',{class:'money'},money(sums[w.id],w.currency))));
    main.append(el('div',{class:'overview-grid'},list,walletList));
  }
  function metric(label,value,cls){return el('section',{class:'card metric'},el('div',{class:'metric-label'},label),el('strong',{class:cls},value));}
  function latestOperations(){const roots=new Map();for(const o of data.operations){const old=roots.get(o.groupId);if(!old||old.revision<o.revision)roots.set(o.groupId,o);}return [...roots.values()].sort((a,b)=>(b.effectiveDate+b.effectiveTime+b.createdAt).localeCompare(a.effectiveDate+a.effectiveTime+a.createdAt));}
  function displayLines(o){return data.expenseLines.filter(x=>x.operationId===(o.status==='cancelled'?o.priorRevisionId:o.id)).sort((a,b)=>(a.orderIndex??0)-(b.orderIndex??0));}
  function operationMemberLabel(o){const lines=displayLines(o);return ['expense','refund'].includes(o.businessType)&&lines.length?[...new Set(lines.map(l=>memberName(l.memberId)))].join(', '):memberName(o.memberId);}
  function operationLabel(o){if(o.links?.contract)return TYPE[o.businessType];if(o.businessType==='income')return categoryName(o.categoryId);if(o.businessType==='refund')return 'Возврат покупки';if(['transfer','fx'].includes(o.businessType))return TYPE[o.businessType];const lines=displayLines(o);return lines.length>1?'Покупка по категориям':categoryName(lines[0]?.categoryId);}
  function operationTable(ops,compact=false){
    return el('div',{class:'table-wrap'},el('table',{},el('thead',{},el('tr',{},['Операция','Дата','Сумма',...(compact?[]:['Кошелек','Автор']),''].map(x=>el('th',{scope:'col'},x)))),el('tbody',{},ops.map(o=>{
      const incoming=o.links?.contract?o.cashDirection===1:['income','refund'].includes(o.businessType),transfer=['transfer','fx'].includes(o.businessType)||o.links?.contract&&!o.cashDirection;
      const amount=(o.status==='cancelled'?'':incoming?'+':transfer?'':'−')+money(o.amount,o.currency);
      return el('tr',{},el('td',{},el('div',{class:'cell-title'},operationLabel(o)),el('div',{class:'cell-sub'},o.comment||TYPE[o.businessType]),o.status==='cancelled'?badge('Отменено','neutral'):null),el('td',{},formatDate(o.effectiveDate),el('div',{class:'cell-sub'},o.effectiveTime)),el('td',{},el('span',{class:'money '+(o.status==='cancelled'?'muted':incoming?'positive':transfer?'':'negative')},amount),o.targetId?el('div',{class:'cell-sub'},'→ '+money(o.receivedAmount,o.targetCurrency||o.currency)):null),compact?null:el('td',{},get(data,'wallets',o.walletId)?.name||'Счет',el('div',{class:'cell-sub'},operationMemberLabel(o))),compact?null:el('td',{},personName(o.actorId)),el('td',{},button('Открыть',()=>operationDetails(o),'small quiet',{'aria-label':'Открыть операцию '+operationLabel(o)})));
    }))));
  }
  const PLAN_STATUS={planned:'Ожидается',partially_fulfilled:'Исполнен частично',fulfilled:'Исполнен',skipped:'Пропущен',cancelled:'Отменен'};
  const GOAL_STATUS={active:'Копим',paused:'На паузе',completed:'Достигнута',archived:'Архив'};
  function progress(value){return el('div',{class:'progress-track',role:'progressbar','aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':Math.max(0,Math.min(100,value))},el('i',{style:`width:${Math.max(0,Math.min(100,value))}%`}));}
  function limitInfo(s,row,month){
    const amount=row.monthOverrides?.[month]??row.defaultAmountRub;if(amount===null||amount===undefined)return null;let spent=0n,missing=false;const ids=new Set(active(s).filter(o=>o.effectiveDate.slice(0,7)===month).map(o=>o.id));
    for(const l of s.expenseLines)if(ids.has(l.operationId)&&(!row.categoryId||l.categoryId===row.categoryId)){if(l.rubSnapshot===null)missing=true;else spent+=BigInt(l.rubSnapshot);}
    const a=BigInt(amount),percent=a?Number(rounded(spent*10000n,a))/100:spent>0n?100:0;return {amount:a,spent,left:a-spent,percent,missing,warning:spent>=a?'Лимит исчерпан':spent*100n>=a*80n?'Достигнуто 80%':'В пределах лимита'};
  }
  function limitCard(row,month,compact=false){const i=limitInfo(data,row,month);if(!i)return null;
    return el('section',{class:'card limit-card'},el('div',{class:'row between'},el('h3',{},row.categoryId?categoryName(row.categoryId):'Общий лимит'),owner()&&!compact?button('Изменить',()=>limitDialog(row,month),'small quiet'):null),el('div',{class:'row between'},el('strong',{class:'money'},money(i.spent)),el('span',{class:'hint'},'из '+money(i.amount))),progress(i.percent),el('p',{class:'hint '+(i.percent>=80?'warning-text':'')},i.spent<0n?'Возвраты превышают расходы этого месяца.':i.warning),el('p',{class:'hint'},i.left<0n?'Превышение '+money(-i.left):'Осталось '+money(i.left)),i.missing?badge('Неполно: нет исторических курсов','warning'):null);
  }
  function renderPlanningSummary(main){
    const due=data.plans.filter(p=>planState(data,p).remaining&&p.date<=monthEnd(today(data))).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,4),goals=data.goals.filter(g=>g.status==='active').sort((a,b)=>a.priority-b.priority).slice(0,3),limits=data.limits.filter(l=>limitInfo(data,l,today(data).slice(0,7)));
    if(!due.length&&!goals.length&&!limits.length)return;
    const grid=el('div',{class:'planning-summary'});
    if(due.length)grid.append(el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},'Ближайшие планы'),button('Все →',()=>navigate('planning'),'link')),due.map(p=>el('div',{class:'list-row'},el('div',{class:'grow'},el('strong',{},p.comment||categoryName(p.categoryId)),el('div',{class:'hint'},formatDate(p.date)+(p.date<today(data)?' · срок прошел':''))),el('span',{class:'money'},(p.kind==='income'?'+':'−')+money(planState(data,p).remaining,p.currency)),button('Открыть',()=>planDetails(p),'small quiet')))));
    if(goals.length)grid.append(el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},'Ближе к цели'),button('Все →',()=>navigate('goals'),'link')),goals.map(g=>{const i=goalInfo(data,g);return el('div',{class:'goal-mini'},el('div',{class:'row between'},el('strong',{},g.name),el('span',{class:'hint'},i.missing?'Нет курса':Math.min(100,Number(i.saved*100n/BigInt(g.target)))+'%')),progress(Number(i.saved*100n/BigInt(g.target))),el('p',{class:'hint'},money(i.saved,g.currency)+' из '+money(g.target,g.currency)));})));
    main.append(grid);if(limits.length)main.append(el('div',{class:'limits-grid'},limits.slice(0,3).map(l=>limitCard(l,today(data).slice(0,7),true))));
  }
  function renderPlanning(main){
    planningMonth||=today(data).slice(0,7);forecastDate||=monthEnd(today(data));
    main.append(header('Планирование','Будущие поступления, платежи и рамки расходов.',owner()?[button('+ Новый план',()=>planDialog(),'primary'),button('Ежемесячно',()=>seriesDialog())]:[]),el('div',{class:'tabs row wrap'},[['plans','Планы'],['series','Повторения'],['limits','Лимиты'],['forecast','Прогноз']].map(([key,label])=>button(label,()=>{planningTab=key;render();},planningTab===key?'active':''))));
    if(planningTab==='forecast'){
      const d=field('Дата прогноза','forecastDate',forecastDate,{type:'date',min:today(data)});d.querySelector('input').addEventListener('change',async e=>{if(!validDate(e.target.value)||e.target.value<today(data)){toast('Дата прогноза не раньше сегодня.',true);return;}forecastDate=e.target.value;await reconcile(forecastDate);render();});main.append(d);const b=budgetInfo(data,forecastDate);
      main.append(el('section',{class:'card forecast-card'},el('div',{class:'eyebrow'},'На '+formatDate(forecastDate)),el('h2',{class:'forecast-value money','data-testid':'forecast-balance'},money(b.forecast)),el('p',{class:'hint'},'При исполнении плана; курсы без изменений. Это деньги на кошельках, включая резервы.'),b.missing?el('div',{class:'notice warning'},'Прогноз неполный: отсутствуют курсы.'):null,b.overdueIncome?el('div',{class:'notice warning'},'Срок получения части доходов прошел; они включены в сценарий.'):null,el('div',{class:'breakdown'},el('p',{},'Сейчас на кошельках: '+money(b.B)),el('p',{},'Еще ожидается поступлений: '+money(b.income)),el('p',{},'Еще ожидается списаний: '+money(b.outgoing)))));return;
    }
    if(planningTab==='series'){
      if(!data.series.length)main.append(el('section',{class:'card'},empty('Рутинные платежи — один раз','Задайте ежемесячную аренду, подписку или зарплату.',owner()?button('Создать повторение',()=>seriesDialog(),'small'):null)));
      for(const series of [...data.series].reverse())main.append(el('section',{class:'card series-card'},el('div',{class:'row between'},el('h3',{},series.template.comment||categoryName(series.template.categoryId)),badge(series.status==='active'?'Активна':'Завершена',series.status==='active'?'':'neutral')),el('p',{},money(series.template.amount,series.template.currency)+' · '+series.monthlyDay+' числа каждого месяца'),el('p',{class:'hint'},formatDate(series.start)+(series.end?' — '+formatDate(series.end):' · без даты окончания')+' · '+(series.autoPost?'Автозапись в сеансе владельца':'Ручное подтверждение')),owner()&&series.status==='active'?el('div',{class:'row wrap'},button('Изменить будущие',()=>seriesDialog(series),'small'),button('Отменить серию',()=>{if(confirm('Прекратить будущие неисполненные платежи? Просроченные останутся.'))run('series.cancel',{id:series.id},'Серия прекращена');},'small quiet')):null));return;
    }
    const monthField=field('Месяц','planningMonth',planningMonth,{type:'month'});monthField.querySelector('input').addEventListener('change',async e=>{if(!validDate(e.target.value+'-01'))return;planningMonth=e.target.value;await reconcile(monthEnd(planningMonth+'-01'));render();});main.append(monthField);
    if(planningTab==='limits'){
      main.append(el('div',{class:'section-head'},el('h2',{},'Лимиты на месяц'),owner()?button('+ Задать лимит',()=>limitDialog(),'primary small'):null),el('p',{class:'hint'},'Общий лимит включает все категории. Лимиты помогают контролировать расходы и не вычитаются из доступных денег. Остатки не переносятся.'));
      const list=data.limits.map(l=>limitCard(l,planningMonth));main.append(el('div',{class:'limits-grid'},list));if(!list.some(Boolean))main.append(empty('Лимиты не заданы','Используйте общий лимит или отдельные рамки для категорий.'));return;
    }
    const kind=field('Показывать','planningKind',planningKind,{choices:[['all','Все планы'],['open','Ожидаемые'],['overdue','Просроченные'],['fulfilled','Исполненные'],['closed','Отмененные и пропущенные']]});kind.querySelector('select').addEventListener('change',e=>{planningKind=e.target.value;render();});main.append(kind);
    const list=data.plans.filter(p=>(p.date.slice(0,7)===planningMonth||p.date<planningMonth+'-01'&&planState(data,p).remaining)&& (planningKind==='all'||planningKind==='open'&&planState(data,p).remaining||planningKind==='overdue'&&p.date<today(data)&&planState(data,p).remaining||planningKind==='fulfilled'&&p.status==='fulfilled'||planningKind==='closed'&&['skipped','cancelled'].includes(p.status))).sort((a,b)=>a.date.localeCompare(b.date));
    const section=el('section',{class:'card plan-list'});for(const p of list){const st=planState(data,p);section.append(el('div',{class:'plan-row','data-plan-id':p.id},el('div',{class:'plan-date'},el('strong',{},p.date.slice(8)),el('span',{},new Intl.DateTimeFormat('ru',{month:'short',timeZone:'UTC'}).format(new Date(p.date+'T12:00Z')))),el('div',{class:'grow'},el('h3',{},p.comment||categoryName(p.categoryId)),el('p',{class:'hint'},get(data,'wallets',p.walletId)?.name+' · '+categoryName(p.categoryId)),el('div',{class:'row wrap'},badge(PLAN_STATUS[st.status],p.date<today(data)&&st.remaining?'warning':'neutral'),p.date<today(data)&&st.remaining?badge('Срок прошел','warning'):null),p.error?el('p',{class:'hint negative'},'Автозапись ожидает: '+p.error):null),el('div',{class:'plan-amount'},el('strong',{class:'money '+(p.kind==='income'?'positive':'')},(p.kind==='income'?'+':'−')+money(st.remaining||p.amount,p.currency)),st.paid?el('div',{class:'hint'},'Факт '+money(st.paid,p.currency)):null),button('Открыть',()=>planDetails(p),'small')));}main.append(list.length?section:el('section',{class:'card'},empty('В этом месяце планов нет','Будущие доходы и расходы можно добавить по желанию.')));
  }
  function planDialog(p=null,request=null){
    if(!data.wallets.some(w=>!w.archived)){walletDialog();return;}
    const row=p||{},w=get(data,'wallets',row.walletId)||data.wallets.find(w=>!w.archived);
    openForm(request?'Рассмотреть изменение плана':p?'Изменить этот платеж':'Новый план',request?'Запрос: '+request.reason:'Будущая запись не меняет текущие деньги.',(body,form)=>{
      body.append(field('Тип *','kind',row.kind||'expense',{choices:[['expense','Расход'],['income','Доход']]}),field('Дата *','date',row.date||today(data),{type:'date',min:family(data).startDate}),field('Кошелек *','walletId',w.id,{choices:optionsWallets()}),field('Сумма *','amount',p?plain(row.amount,get(data,'currencies',row.currency).decimals):'',{inputmode:'decimal'}),field('Категория *','categoryId',row.categoryId||'groceries',{choices:optionsCategories(row.kind||'expense',row.categoryId)}),field('Название / комментарий','comment',row.comment||'',{maxlength:1000}),field('Покрыть резервом цели','coverageGoalId',row.reserveCoverage?.goalId||'',{choices:[['','Без покрытия'],...data.goals.filter(g=>g.status!=='archived').map(g=>[g.id,g.name])]}),field('Сумма покрытия в валюте кошелька','coverageAmount',row.reserveCoverage?plain(coverageLeft(data,p),get(data,'currencies',row.currency).decimals):'',{inputmode:'decimal'}));
      form.elements.kind.addEventListener('change',()=>{const select=form.elements.categoryId;select.replaceChildren(...optionsCategories(form.elements.kind.value).map(([key,label])=>el('option',{value:key},label)));});
    },async(form,opts)=>{const payload={...values(form),id:p?.id};if(request)await command('proposal.decide',{id:request.id,approve:true,payload},opts);else await command('plan.save',payload,opts);return 'План сохранен';});
  }
  function planDetails(p){const st=planState(data,p);
    if(p.module){openContract(p.module,p.moduleId,p);return;}
    openForm('План: '+(p.comment||categoryName(p.categoryId)),formatDate(p.date)+' · '+PLAN_STATUS[st.status],body=>{
      body.append(el('div',{class:'review-box'},el('h2',{class:'money'},money(p.amount,p.currency)),el('p',{},'Исполнено: '+money(st.paid,p.currency)),el('p',{},'Еще ожидается: '+money(st.remaining,p.currency)),st.excess?el('p',{},'Превышение: '+money(st.excess,p.currency)):null,coverageLeft(data,p)?el('p',{},'Покрыто резервом: '+money(coverageLeft(data,p),p.currency)):null,el('p',{class:'hint'},'Кошелек: '+get(data,'wallets',p.walletId)?.name)));
      for(const l of st.links){const o=get(data,'operations',l.operationId);body.append(button('Факт: '+money(o.amount,o.currency)+' · '+formatDate(o.effectiveDate),()=>{closeDialog(true);operationDetails(o);},'link'));}
      const controls=el('div',{class:'row wrap'});if(st.remaining&&canSubmit())controls.append(button(p.kind==='income'?'Получено':'Оплачено',()=>{closeDialog(true);operationDialog(p.kind,null,{walletId:p.walletId,amount:plain(st.remaining,get(data,'currencies',p.currency).decimals),categoryId:p.categoryId,comment:p.comment,planId:p.id,date:today(data)});},'primary'));
      if(owner()){
        if(st.remaining)controls.append(button('Изменить этот платеж',()=>{closeDialog(true);planDialog(p);},'small'));
        if(st.remaining)controls.append(button('Пропустить',()=>{closeDialog(true);run('plan.status',{id:p.id,status:'skipped'},'Ожидание пропущено');},'small quiet'),button('Отменить ожидание',()=>{closeDialog(true);run('plan.status',{id:p.id,status:'cancelled'},'Ожидание отменено');},'small quiet'));
        if(['skipped','cancelled'].includes(p.status))controls.append(button('Вернуть ожидание',()=>{closeDialog(true);run('plan.status',{id:p.id,status:'planned'},'План восстановлен');},'small'));
        if(p.seriesId&&st.remaining)controls.append(button('Этот и будущие',()=>{closeDialog(true);seriesDialog(get(data,'series',p.seriesId),p.date);},'small quiet'));
      }else if(canSubmit())controls.append(button('Запросить изменение',()=>{closeDialog(true);openForm('Запрос владельцу','Опишите, как нужно изменить план.',b=>b.append(field('Причина / изменение *','reason','',{type:'textarea',maxlength:300})),async(form,opts)=>{await command('plan.request',{id:p.id,reason:formValue(form,'reason')},opts);return 'Запрос отправлен';});},'small quiet'));
      body.append(controls);
    },null,null);
  }
  function seriesDialog(series=null,from=today(data)){
    if(!data.wallets.some(w=>!w.archived)){walletDialog();return;}const t=series?.template||{},w=get(data,'wallets',t.walletId)||data.wallets.find(w=>!w.archived);
    openForm(series?'Этот и будущие платежи':'Ежемесячный план','Автозапись — запись в учете, не подтверждение банка. Она работает только в открытом сеансе владельца.',(body,form)=>{
      body.append(field('Тип *','kind',t.kind||'expense',{choices:[['expense','Расход'],['income','Доход']]}),field('Начало серии *','start',series?from:today(data),{type:'date',min:family(data).startDate}),field('День месяца *','monthlyDay',series?.monthlyDay||Number(today(data).slice(8)),{type:'number',min:1,max:31}),field('Дата окончания · необязательно','end',series?.end||'',{type:'date'}),field('Кошелек *','walletId',w.id,{choices:optionsWallets()}),field('Сумма *','amount',t.amount?plain(t.amount,get(data,'currencies',t.currency).decimals):'',{inputmode:'decimal'}),field('Категория *','categoryId',t.categoryId||'home',{choices:optionsCategories(t.kind||'expense',t.categoryId)}),field('Название / комментарий','comment',t.comment||'',{maxlength:1000}),check('Автоматически фиксировать наступившие платежи','autoPost',!!series?.autoPost),el('p',{class:'hint'},'В коротком месяце используется последний день; затем возвращается исходное число. Неисполненные прошлые даты сохраняются.'));
      form.elements.kind.addEventListener('change',()=>form.elements.categoryId.replaceChildren(...optionsCategories(form.elements.kind.value).map(([key,label])=>el('option',{value:key},label))));
    },async(form,opts)=>{await command('series.save',{...values(form),id:series?.id,from:from<today(data)?today(data):from,autoPost:formCheck(form,'autoPost')},opts);return 'Серия сохранена';});
  }
  function limitDialog(row=null,month=''){
    openForm('Лимит расходов','Базовое значение повторяется каждый месяц. Переопределение действует только в выбранном месяце.',body=>body.append(field('Категория','categoryId',row?.categoryId||'',{choices:[['','Все расходы · общий лимит'],...optionsCategories('expense',row?.categoryId)]}),field('Месяц · пусто для базового значения','month',month,{type:'month'}),field('Лимит, RUB *','amount',plain(row?(row.monthOverrides?.[month]??row.defaultAmountRub??0):0,2),{inputmode:'decimal'}),check('Убрать выбранное ограничение','remove')),async(form,opts)=>{await command('limit.save',{...values(form),remove:formCheck(form,'remove')},opts);return 'Лимит сохранен';});
  }
  function renderGoals(main){
    main.append(header('Ваши цели','Закрепляйте имеющиеся деньги и выбирайте удобный темп накоплений.',owner()?[button('+ Новая цель',()=>goalDialog(),'primary'),button('Ожидаемый доход',expectedIncomeDialog)]:[]));
    const expected=BigInt(family(data).expectedMonthlyIncome||0),b=budgetInfo(data);let need=0n,missing=false;for(const g of data.goals.filter(g=>g.status==='active')){const i=goalInfo(data,g),v=inRub(data,i.monthPlan,g.currency,today(data));if(v===null&&i.monthPlan)missing=true;else need+=v||0n;missing||=i.missing;}
    main.append(el('section',{class:'card goals-summary'},el('div',{},el('div',{class:'eyebrow'},'Месячный ориентир всех активных целей'),el('strong',{class:'money'},money(need))),el('div',{},el('p',{class:'hint'},'Ожидаемый доход: '+(expected?money(expected):'не задан')),el('p',{class:'hint'},'За вычетом оставшихся расходов месяца: '+(expected?money(expected-b.outgoing):'—'))),missing?badge('Неполно: нет курсов','warning'):null,expected&&need>expected-b.outgoing?badge('План накоплений выше свободного дохода','warning'):null));
    const grid=el('div',{class:'goal-grid'});for(const g of [...data.goals].sort((a,b)=>Number(a.status==='archived')-Number(b.status==='archived')||a.priority-b.priority)){const i=goalInfo(data,g),pct=Number(i.saved*10000n/BigInt(g.target))/100;
      const card=el('section',{class:'card goal-card','data-goal-id':g.id},el('div',{class:'row between'},badge('Приоритет '+g.priority,'neutral'),badge(GOAL_STATUS[g.status],g.status==='paused'?'warning':'')),el('h2',{},g.name),el('div',{class:'goal-amount money'},money(i.saved,g.currency)),el('p',{class:'hint'},'из '+money(g.target,g.currency)),progress(pct),el('p',{class:'hint'},i.missing?'Прогресс неполный: нет курса.':Math.min(100,pct).toLocaleString('ru-RU')+'% · осталось '+money(i.remaining,g.currency)),el('p',{class:'hint'},'План месяца '+money(i.monthPlan,g.currency)+' · учтено '+money(i.net,g.currency)+' · еще отложить '+money(i.left,g.currency)),el('div',{class:'goal-calculation'},el('strong',{},i.overdue?'Срок прошел':!i.remaining?'Сумма накоплена':i.finish?'Ориентир: '+formatDate(i.finish):'Срок не рассчитан'),el('p',{class:'hint'},i.oneOff?'Нужен разовый взнос: '+money(i.remaining,g.currency):money(i.monthly,g.currency)+' / месяц'+(i.percent===null?'':' · '+i.percent.toLocaleString('ru-RU')+'% дохода')),i.count?el('p',{class:'hint'},i.count+' взносов · последний '+money(i.last,g.currency)):null,g.mode==='date'?el('p',{class:'hint'},'Эквивалент: '+money(i.daily,g.currency)+' / день · '+money(i.weekly,g.currency)+' / неделю'):null,i.percent!==null&&i.percent>100?badge('Взнос больше ожидаемого дохода','warning'):null),g.comment?el('p',{class:'hint'},g.comment):null);
      if(g.kind==='credit'){const l=get(data,'loans',g.linkedLoanId);if(l){const debt=convert(data,loanState(data,l).principal,l.currency,g.currency);card.append(el('p',{class:'hint'},'Основной долг сейчас: '+money(debt,g.currency)+'. Выбранная сумма цели: '+money(g.target,g.currency)+(debt!==null&&debt!==BigInt(g.target)?' · отличается от долга.':'.')));}}const reserves=reserveBalances(data);for(const [key,a]of Object.entries(reserves))if(key.startsWith(g.id+'|')&&a)card.append(el('div',{class:'list-row'},el('span',{class:'grow hint'},get(data,'wallets',key.split('|')[1])?.name),el('strong',{class:'money'},money(a,get(data,'wallets',key.split('|')[1]).currency))));
      if(owner()&&g.status!=='archived')card.append(el('div',{class:'row wrap goal-actions'},button('Отложить',()=>reserveDialog(g),'small primary'),button('Освободить',()=>reserveDialog(g,true),'small'),button(g.kind==='credit'?'Направить на погашение':'Оплатить из цели',()=>spendGoalDialog(g),'small'),button('Изменить',()=>goalDialog(g),'small quiet'),button(g.status==='active'?'Пауза':'Возобновить',()=>run('goal.status',{id:g.id,status:g.status==='active'?'paused':'active'},'Статус изменен'),'small quiet'),g.status!=='completed'&&!i.remaining&&!i.missing?button('Завершить',()=>run('goal.status',{id:g.id,status:'completed'},'Цель достигнута'),'small'):null,button('В архив',()=>{if(confirm('Архивировать цель и освободить ее резервы?'))run('goal.status',{id:g.id,status:'archived',releaseConfirmed:true},'Цель в архиве');},'small quiet')));grid.append(card);
    }main.append(data.goals.length?grid:el('section',{class:'card'},empty('Для чего хочется накопить?','Добавьте небольшую покупку или большую семейную цель.',owner()?button('Создать цель',()=>goalDialog(),'small'):null)));
  }
  function expectedIncomeDialog(){openForm('Ожидаемый месячный доход','Ориентир для процента накоплений. Он не увеличивает баланс и не создает будущие поступления.',body=>body.append(field('Доход семьи в месяц, RUB *','expectedMonthlyIncome',plain(family(data).expectedMonthlyIncome||0,2),{inputmode:'decimal'})),async(form,opts)=>{await command('planning.settings',values(form),opts);return 'Ориентир сохранен';});}
  function goalDialog(g=null){const dec=get(data,'currencies',g?.currency||'RUB').decimals;
    openForm(g?'Изменить цель':'Новая цель','Резерв закрепляет уже имеющиеся деньги. План взносов не переводит их автоматически.',(body,form)=>{
      body.append(field('Тип цели','kind',g?.kind||'saving',{choices:[['saving','Покупка / накопление'],['credit','Досрочное погашение кредита']]}),field('Кредит для погашения','linkedLoanId',g?.linkedLoanId||'',{choices:[['','Выберите кредит'],...data.loans.filter(l=>l.status!=='cancelled').map(l=>[l.id,l.name])]}),field('Название *','name',g?.name||'',{maxlength:100}),el('div',{class:'form-grid'},field('Стоимость / сумма *','target',g?plain(g.target,dec):'',{inputmode:'decimal'}),field('Валюта *','currency',g?.currency||'RUB',{choices:data.currencies.map(c=>[c.code,c.code]),disabled:!!g})),field('Как копить','mode',g?.mode||'date',{choices:[['date','К выбранной дате'],['pace','В комфортном темпе']]}),field('Желаемая дата *','dueDate',g?.dueDate||'',{type:'date'}),field('Способ взноса','contributionType',g?.contributionType||'amount',{choices:[['amount','Фиксированная сумма'],['percent','Процент ожидаемого дохода']]}),field('Месячный взнос','contributionAmount',g?plain(g.contributionAmount||0,dec):'',{inputmode:'decimal'}),field('Доля дохода, %','contributionPercent',g?.contributionPercent||'10',{inputmode:'decimal',hint:'Доход задается отдельно кнопкой «Ожидаемый доход». При нулевом доходе процент недоступен.'}),el('div',{class:'form-grid'},field('Первый взнос *','firstDate',g?.firstDate||today(data),{type:'date'}),field('День месяца *','contributionDay',g?.contributionDay||Number(today(data).slice(8)),{type:'number',min:1,max:31})),field('Приоритет','priority',g?.priority||2,{choices:[[1,'1 · высокий'],[2,'2 · обычный'],[3,'3 · невысокий']]}),field('Комментарий','comment',g?.comment||'',{type:'textarea',maxlength:1000}));
      if(!g)body.append(el('div',{class:'form-section'},'Уже накоплено · необязательно'),field('Из кошелька','initialWalletId','',{choices:[['','Не назначать сейчас'],...optionsWallets()]}),field('Сумма в валюте кошелька','initialAmount','',{inputmode:'decimal'}),check('Считать взносом текущего месяца','initialCounts',false));
      const update=()=>{form.elements.linkedLoanId.closest('.field').hidden=formValue(form,'kind')!=='credit';const date=formValue(form,'mode')==='date',percent=formValue(form,'contributionType')==='percent';for(const name of ['dueDate','contributionType','contributionAmount','contributionPercent'])form.elements.namedItem(name).closest('.field').hidden=name==='dueDate'?!date:date||name==='contributionAmount'&&percent||name==='contributionPercent'&&!percent;};form.elements.kind.addEventListener('change',()=>{if(formValue(form,'kind')==='saving')form.elements.linkedLoanId.value='';update();});form.elements.linkedLoanId.addEventListener('change',()=>{const l=get(data,'loans',formValue(form,'linkedLoanId'));if(l&&!g){form.elements.currency.value=l.currency;form.elements.target.value=plain(loanState(data,l).principal,get(data,'currencies',l.currency).decimals);}update();});form.elements.mode.addEventListener('change',update);form.elements.contributionType.addEventListener('change',update);update();
    },async(form,opts)=>{await command('goal.save',{...values(form),currency:g?.currency||formValue(form,'currency'),id:g?.id,initialCounts:formCheck(form,'initialCounts')},opts);return 'Цель сохранена';});
  }
  function reserveDialog(g,release=false){
    openForm(release?'Освободить резерв':'Отложить на цель',g.name+' · сумма в валюте выбранного кошелька',body=>body.append(field('Кошелек *','walletId',(data.wallets.find(w=>!w.archived&&w.currency===g.currency&&w.primaryForCurrency)||data.wallets.find(w=>!w.archived&&w.currency===g.currency)||data.wallets.find(w=>!w.archived))?.id||'',{choices:optionsWallets()}),field('Сумма *','amount','',{inputmode:'decimal'}),!release?check('Считать взносом текущего месяца','countsForMonthlyPlan',true):'',el('div',{class:'review-box'},data.wallets.filter(w=>!w.archived).map(w=>el('div',{},w.name+': свободно '+money(balances(data)[w.id]-reservedOn(data,w.id),w.currency)+' · резерв цели '+money(reserveBalances(data)[g.id+'|'+w.id]||0,w.currency))))),async(form,opts)=>{await command('goal.reserve',{...values(form),goalId:g.id,release,countsForMonthlyPlan:formCheck(form,'countsForMonthlyPlan')},opts);return release?'Резерв освобожден':'Деньги отложены';});
  }
  function spendGoalDialog(g){if(g.kind==='credit'){const l=get(data,'loans',g.linkedLoanId);if(l?.status==='active')loanPaymentDialog(l,'early',null,g);else toast('Выбранный кредит уже закрыт.',true);return;}const reserves=Object.entries(reserveBalances(data)).filter(([key,a])=>key.startsWith(g.id+'|')&&a>0n);if(!reserves.length){toast('Сначала назначьте резерв из кошелька.',true);return;}const walletId=reserves[0][0].split('|')[1];operationDialog('expense',null,{walletId,reserveGoalId:g.id});}
  const percentText=value=>String(value).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'').replace('.',',');
  const contractWallets=currency=>optionsWallets().filter(([key])=>!currency||get(data,'wallets',key).currency===currency);
  function contractIncome(s,module,key){return active(s).filter(o=>o.links?.contract?.module===module&&o.links.contract.id===key).reduce((n,o)=>n+(o.incomeComponents||[]).reduce((a,c)=>a+BigInt(c.amount),0n),0n);}
  function contractFields(body,walletId,goalId=''){
    const state=el('div',{class:'review-box'}),form=body.closest('form');const update=()=>{const key=formValue(form,'walletId')||formValue(form,'sourceWalletId')||walletId,w=get(data,'wallets',key);state.textContent=w?`На счете «${w.name}»: свободно ${money(balances(data)[w.id]-reservedOn(data,w.id),w.currency)}, в резервах ${money(reservedOn(data,w.id),w.currency)}.`:'';};body.append(state);form.addEventListener('change',update);update();
    body.append(field('Освободить резерв цели · при необходимости','reserveGoalId',goalId,{choices:[['','Без резерва'],...data.goals.filter(g=>g.status!=='archived').map(g=>[g.id,g.name])]}),field('Сумма освобождения в валюте кошелька','reserveAmount','',{inputmode:'decimal'}),check('Разрешить отрицательный остаток','allowOverdraft'),field('Причина отрицательного остатка','overdraftReason','',{maxlength:300}));
  }
  function contractFormValues(form){const p=values(form);p.allowOverdraft=formCheck(form,'allowOverdraft');p.reserveActions=p.reserveGoalId&&p.reserveAmount?[{goalId:p.reserveGoalId,walletId:p.walletId||p.sourceWalletId,amount:p.reserveAmount}]:[];return p;}
  function editingState(module,event){const s=clone(data);if(!event)return s;const o=get(s,'operations',event.operationId);if(o)o.status='superseded';const store=module==='deposit'?'deposits':module==='loan'?'loans':'personalDebts';get(s,store,event.contractId).status='active';if(module==='loan')for(const r of s.loanSchedules.filter(r=>r.loanId===event.contractId)){const prev=event.scheduleBefore?.find(x=>x.id===r.id);if(prev)r.status=prev.status;else if(r.createdByEventId===event.id)r.status='cancelled';}for(const link of s.planLinks.filter(l=>l.operationId===event.operationId))link.status='reversed';return s;}
  function openContract(module,key,plan=null){
    if(module==='deposit'){const d=get(data,'deposits',key);if(d)depositDetails(d);}
    if(module==='loan'){const l=get(data,'loans',key);if(l)loanDetails(l,plan?.scheduleRowId);}
    if(module==='debt'){const d=get(data,'personalDebts',key);if(d)debtDetails(d);}
  }
  function receiveLoanDialog(l){openForm('Получить кредит','Будет зачислено '+money(l.principalAtStart,l.currency)+' заемных средств. Обычный доход не увеличивается.',body=>body.append(field('Дата получения *','date',today(data),{type:'date'})),async(form,opts)=>{await command('loan.receive',{id:l.id,...values(form)},opts);return 'Кредит получен';},'Подтвердить получение');}
  function contractHistory(body,module,key){
    const store=module==='deposit'?'depositEvents':module==='loan'?'loanEvents':'debtEvents',events=contractEvents(data,store,key),record=get(data,module==='deposit'?'deposits':module==='loan'?'loans':'personalDebts',key),currency=record.currency;
    body.append(el('div',{class:'form-section'},'Подтвержденная история'));
    if(!events.length)body.append(el('p',{class:'hint'},'Фактических движений после начала учета пока нет.'));
    if(owner()&&!events.length&&['active','planned'].includes(record.status))body.append(button('Отменить начальную запись',()=>{closeDialog(true);openForm('Отменить начальную запись','Используйте при ошибке ввода до первого фактического движения. История сохранится.',b=>b.append(field('Причина *','reason','',{maxlength:300})),async(form,opts)=>{await command('contract.void',{module,id:key,...values(form)},opts);return 'Начальная запись отменена';});},'small quiet'));
    for(const e of [...events].reverse()){
      const o=get(data,'operations',e.operationId),row=el('section',{class:'event-row'},el('div',{class:'row between'},el('strong',{},TYPE[o.businessType]),el('span',{class:'hint'},formatDate(e.date))),el('p',{class:'money'},money(o.amount,currency)));
      if(module==='loan')row.append(el('p',{class:'hint'},`Тело ${money(e.principal||0,currency)} · проценты ${money(e.interest||0,currency)} · комиссии ${money(e.fees||0,currency)}`));
      if(module==='deposit'&&['interest','capitalization','close'].includes(e.type))row.append(el('p',{class:'hint'},`Расчет ${money(e.calculatedAmount||0,currency)} · факт ${money(e.actualAmount||0,currency)} · разница ${money(BigInt(e.actualAmount||0)-BigInt(e.calculatedAmount||0),currency)}`));
      if(module==='debt'&&e.type==='return')row.append(el('p',{class:'hint'},`Тело ${money(e.principal,currency)} · проценты ${money(e.interest,currency)}`));
      if(owner())row.append(el('div',{class:'row wrap'},e.type!=='open'?button(module==='deposit'?'Сверить с банком':'Исправить',()=>{closeDialog(true);if(module==='deposit'){if(e.type==='close')depositCloseDialog(record,e);else depositActionDialog(record,e.type==='capitalization'||e.type==='interest'?'reconcile':e.type,e);}if(module==='loan')loanPaymentDialog(record,e.type==='early'?'early':'payment',e.rowId,null,e);if(module==='debt')debtPaymentDialog(record,e);},'small quiet'):null,button('Отменить событие',()=>{closeDialog(true);openForm('Отменить событие','Сначала отменяются последующие зависимые выплаты. Остатки и планы восстановятся вместе.',b=>b.append(field('Причина *','reason','',{maxlength:300})),async(form,opts)=>{await command('contract.cancel',{module,contractId:key,eventId:e.id,reason:formValue(form,'reason')},opts);return 'Событие отменено';});},'small quiet')));body.append(row);
    }
  }
  function renderDeposits(main){
    main.append(header('Вклады','Деньги работают, а расчетные проценты отделены от полученных.',owner()?[button('+ Добавить депозит',()=>depositDialog(),'primary')]:[]));
    if(!data.deposits.length){main.append(el('section',{class:'card'},empty('Сбережения могут приносить доход','Добавьте новый вклад или тот, который уже открыт.',owner()?button('Добавить депозит',()=>depositDialog(),'small'):null)));return;}
    const grid=el('div',{class:'contract-grid'});for(const d of data.deposits){const state=depositProjection(data,d,today(data)),forecast=depositProjection(data,d,d.endDate,{future:true}),next=forecast.rows[0],balance=depositBalance(data,d),income=contractIncome(data,'deposit',d.id);grid.append(el('section',{class:'card contract-card','data-deposit-id':d.id},el('div',{class:'row between'},badge(d.status==='active'?'Работает':d.status==='closed'?'Закрыт':'Отменен',d.status==='active'?'':'neutral'),el('span',{class:'hint'},d.bank)),el('h2',{},d.name),el('div',{class:'contract-amount money'},money(balance,d.currency)),el('p',{class:'hint'},'Основной остаток · '+percentText(depositRate(d,today(data)))+'% годовых'),el('div',{class:'contract-metrics'},el('p',{},'Подтвержденный доход',el('strong',{class:'money'},money(income,d.currency))),el('p',{},'Начисленная оценка',el('strong',{class:'money'},money(d.status==='active'?state.accrued:0,d.currency))),el('p',{},'До конца срока · оценка процентов',el('strong',{class:'money'},money(forecast.projectedIncome,d.currency)))),el('p',{class:'hint'},`${formatDate(d.openingDate)} — ${formatDate(d.endDate)} · осталось ${Math.max(0,dayNumber(d.endDate)-dayNumber(today(data)))} дн.`),next&&d.status==='active'?el('p',{class:'hint'},'Ближайшая дата '+formatDate(next.date)+(next.date<today(data)?' · срок прошел':'')):null,el('div',{class:'row wrap contract-actions'},button('Открыть вклад',()=>depositDetails(d),'small'),owner()&&d.status==='active'?button('Сверить с банком',()=>depositActionDialog(d,'reconcile'),'small quiet'):null)));}main.append(grid);
    main.append(el('p',{class:'hint'},'ACT/ACT: фактические календарные дни, 365 или 366 дней в году. Прогноз до налогов; фактическую сумму подтверждайте по банку. Вклад не является резервом цели.'));
  }
  function depositDialog(d=null){
    if(!data.wallets.some(w=>!w.archived)){walletDialog();return;}const initialWallet=data.wallets.find(w=>!w.archived&&w.currency===(d?.currency||'RUB'))||data.wallets.find(w=>!w.archived),mode=d?.mode||'new';
    openForm(d?'Условия вклада':'Добавить депозит','Новый вклад перемещает деньги с кошелька; существующий добавляется как стартовый актив.',(body,form)=>{
      body.append(field('Название *','name',d?.name||'',{maxlength:100}),field('Банк / организация','bank',d?.bank||'',{maxlength:100}),field('Режим','mode',mode,{choices:[['new','Открываю новый вклад'],['existing','Уже был на дату начала учета']],disabled:!!d}),field('Валюта *','currency',d?.currency||initialWallet.currency,{choices:data.currencies.map(c=>[c.code,c.code]),disabled:!!d}),el('div',{class:'form-grid'},field('Дата открытия *','openingDate',d?.openingDate||today(data),{type:'date',disabled:!!d}),field('Дата окончания *','endDate',d?.endDate||addDays(today(data),365),{type:'date'})),field('Основная сумма *','principal',d?plain(d.originalPrincipal,get(data,'currencies',d.currency).decimals):'',{inputmode:'decimal',readonly:!!d&&d.mode==='new'}),field('Кошелек открытия','sourceWalletId',initialWallet.id,{choices:optionsWallets()}),check('Подтверждаю: эти деньги не включены в стартовые кошельки','noDuplicateConfirmed',!!d),field('Невыплаченные проценты до начала учета','initialUnpaidInterest',d?plain(d.initialUnpaidInterest,get(data,'currencies',d.currency).decimals):'0',{inputmode:'decimal'}),field('Годовая ставка, % *','annualRate',d?.rateIntervals[0]?.rate||'',{inputmode:'decimal'}),field('Ставки по датам · необязательно','intervalsText',d&&d.rateIntervals.length>1?d.rateIntervals.map(r=>r.date+' '+r.rate).join('\n'):'',{type:'textarea',hint:'Одна строка: ГГГГ-ММ-ДД ставка. Если заполнено, первая дата покрывает начало срока.'}),field('Выплата процентов','payoutMode',d?.payoutMode||'monthly',{choices:[['monthly','Ежемесячно'],['end','В конце срока']]}),check('Капитализировать проценты','capitalizes',!!d?.capitalizes),field('День ежемесячной выплаты *','payoutDay',d?.payoutDay||Number(today(data).slice(8)),{type:'number',min:1,max:31}),field('Кошелек выплаты *','payoutWalletId',d?.payoutWalletId||initialWallet.id,{choices:optionsWallets()}),check('Пополнение разрешено','topupAllowed',d?.topupAllowed??true),check('Частичное снятие разрешено','withdrawalAllowed',d?.withdrawalAllowed??false),field('Неснижаемый остаток','minBalance',d?plain(d.minBalance,get(data,'currencies',d.currency).decimals):'0',{inputmode:'decimal'}),field('Ставка досрочного закрытия, %','earlyRate',d?.earlyRate||'0',{inputmode:'decimal'}),field('Комментарий','comment',d?.comment||'',{type:'textarea',maxlength:1000}));if(!d)contractFields(body,initialWallet.id);
      const update=()=>{const existing=(d?.mode||formValue(form,'mode'))==='existing',end=formValue(form,'payoutMode')==='end';for(const name of ['noDuplicateConfirmed','initialUnpaidInterest'])form.elements.namedItem(name).closest(name==='noDuplicateConfirmed'?'.check':'.field').hidden=!existing;form.elements.sourceWalletId.closest('.field').hidden=existing||!!d;form.elements.capitalizes.closest('.check').hidden=end;if(end)form.elements.capitalizes.checked=false;form.elements.payoutDay.closest('.field').hidden=end;};form.elements.mode.addEventListener('change',()=>{if(!d&&formValue(form,'mode')==='existing')form.elements.openingDate.value=family(data).startDate;update();});form.elements.payoutMode.addEventListener('change',update);update();
    },async(form,opts)=>{const p=contractFormValues(form);p.mode=d?.mode||p.mode;p.currency=d?.currency||p.currency;p.openingDate=d?.openingDate||p.openingDate;p.id=d?.id;for(const name of ['noDuplicateConfirmed','capitalizes','topupAllowed','withdrawalAllowed'])p[name]=formCheck(form,name);if(p.intervalsText.trim())p.rateIntervals=p.intervalsText.trim().split('\n').map(line=>{const [date,rate]=line.trim().split(/\s+/);return {date,rate};});await command('deposit.save',p,opts);return 'Вклад сохранен';});
  }
  function depositDetails(d){
    const state=depositProjection(data,d,today(data)),forecast=depositProjection(data,d,d.endDate,{future:true});openForm(d.name,'Условия, ожидаемые выплаты и подтвержденные движения.',body=>{
      body.append(el('div',{class:'review-box'},el('h2',{class:'money'},money(depositBalance(data,d),d.currency)),el('p',{},'Доход за время учета: '+money(contractIncome(data,'deposit',d.id),d.currency)),el('p',{},'Начислено расчетно: '+money(state.accrued,d.currency)),el('p',{class:'hint'},'ACT/ACT, до налогов. Фактические начисления могут отличаться.'),el('p',{class:'hint'},(d.topupAllowed?'Пополнение разрешено':'Без пополнения')+' · '+(d.withdrawalAllowed?'Снятие от '+money(d.minBalance,d.currency):'Без частичного снятия'))));
      if(owner()&&d.status==='active')body.append(el('div',{class:'row wrap'},button('Пополнить',()=>{closeDialog(true);depositActionDialog(d,'topup');},'small',{disabled:!d.topupAllowed}),button('Снять часть',()=>{closeDialog(true);depositActionDialog(d,'withdraw');},'small',{disabled:!d.withdrawalAllowed}),button('Подтвердить проценты',()=>{closeDialog(true);depositActionDialog(d,'interest');},'small'),button('Сверить с банком',()=>{closeDialog(true);depositActionDialog(d,'reconcile');},'small'),button('Закрыть вклад',()=>{closeDialog(true);depositCloseDialog(d);},'small'),button('Условия',()=>{closeDialog(true);depositDialog(d);},'small quiet'),button('Будущая ставка',()=>{closeDialog(true);openForm('Новая ставка','Ставка применяется с будущего дня; подтвержденные выплаты сохраняются.',b=>b.append(field('Дата *','date',addDays(today(data)),{type:'date'}),field('Ставка, % *','rate','',{inputmode:'decimal'})),async(form,opts)=>{await command('deposit.rate',{id:d.id,...values(form)},opts);return 'Ставка добавлена';});},'small quiet')));
      if(forecast.rows.length&&d.status==='active'){body.append(el('div',{class:'form-section'},'Предстоящие даты · расчет'));for(const r of forecast.rows)body.append(el('div',{class:'list-row'},el('span',{class:'grow'},formatDate(r.date)+(r.closing?' · закрытие':d.capitalizes?' · капитализация':' · выплата')),el('strong',{class:'money'},money(r.amount,d.currency))));}contractHistory(body,'deposit',d.id);
    },null,null);
  }
  function depositActionDialog(d,action,event=null){
    const s=editingState('deposit',event),record=get(s,'deposits',d.id),confirmed=new Set(contractEvents(s,'depositEvents',d.id).filter(e=>['interest','capitalization','close'].includes(e.type)).map(e=>e.date)),next=depositDates(s,d).find(date=>!confirmed.has(date)),interest=['interest','reconcile'].includes(action);
    if(interest&&!next){toast('Все даты выплат подтверждены.',true);return;}if(action==='interest'&&next===d.endDate){depositCloseDialog(d,event);return;}
    const date=event?.date||(interest?next:today(s)<d.endDate?today(s):d.endDate),draft=data.depositEvents.find(e=>e.contractId===d.id&&e.date===date&&e.type==='reconciliation'&&!e.operationId),calculated=depositProjection(s,record,date).accrued,actual=event?.actualAmount||draft?.actualAmount||calculated,dec=get(data,'currencies',d.currency).decimals;
    openForm(action==='topup'?'Пополнить вклад':action==='withdraw'?'Снять часть вклада':action==='reconcile'?'Сверить с банком':d.capitalizes?'Подтвердить капитализацию':'Подтвердить проценты',d.name+' · '+d.currency,(body,form)=>{
      body.append(field('Дата *','date',date,{type:'date'}),field('Кошелек *','walletId',get(data,'operations',event?.operationId)?.walletId||d.payoutWalletId,{choices:contractWallets(d.currency)}));
      if(interest){body.append(el('div',{class:'review-box'},'Расчет по ACT/ACT: '+money(calculated,d.currency)),field('Фактические проценты банка *','actualAmount',plain(actual,dec),{inputmode:'decimal'}),el('p',{class:'hint'},action==='reconcile'&&!event?'Сверка сохраняет факт для следующего подтверждения и не зачисляет деньги.':'Сумма будет учтена один раз. Подтвержденную выплату можно сверить через историю.'));}
      else {body.append(field('Сумма *','amount',event?plain(event.actualAmount,dec):'',{inputmode:'decimal'}));if(action==='topup')contractFields(body,d.payoutWalletId);}
      body.append(field(event?'Причина исправления *':'Причина / примечание','reason',event?.reason||'',{maxlength:300}));
    },async(form,opts)=>{await command('deposit.'+action,{...contractFormValues(form),id:d.id,editEventId:event?.id},opts);return action==='reconcile'&&!event?'Сверка сохранена':'Событие вклада сохранено';},action==='reconcile'?'Сохранить сверку':'Подтвердить');
  }
  function depositCloseDialog(d,event=null){const s=editingState('deposit',event),record=get(s,'deposits',d.id),dec=get(s,'currencies',d.currency).decimals,date=event?.date||(today(s)>d.endDate?d.endDate:today(s));
    openForm('Закрыть вклад',d.name+' · подтвердите фактический возврат банка.',(body,form)=>{
      body.append(field('Дата закрытия *','date',date,{type:'date',max:d.endDate}),field('Кошелек получения *','walletId',d.payoutWalletId,{choices:contractWallets(d.currency)}),el('div',{class:'review-box',id:'deposit-close-preview'}),field('Возврат тела · в срок *','returnedPrincipal',plain(event?-BigInt(event.principalDelta):depositBalance(s,record,date),dec),{inputmode:'decimal'}),field('Фактические проценты · в срок *','actualInterest',event&&!event.early?plain(BigInt(event.actualAmount)+BigInt(event.withholding),dec):'',{inputmode:'decimal'}),field('Фактически возвращено всего · досрочно *','actualReturn',event?plain(event.actualReturn,dec):'',{inputmode:'decimal'}),field('Фактическое удержание банка *','withholding',event?plain(event.withholding,dec):d.mode==='existing'?'':'0',{inputmode:'decimal'}),field('Причина отличия / исправления','reason',event?.reason||'',{maxlength:300}),check('Подтверждаю фактические возврат и удержание','confirmed'));
      const update=()=>{const date=formValue(form,'date');if(!validDate(date))return;const early=date<d.endDate,projection=depositProjection(s,record,date),preview=form.querySelector('#deposit-close-preview');form.elements.returnedPrincipal.closest('.field').hidden=early;form.elements.actualInterest.closest('.field').hidden=early;form.elements.actualReturn.closest('.field').hidden=!early;
        if(early){const i=depositEarly(s,record,date);preview.textContent=`Расчетный возврат ${money(i.returnAmount,d.currency)}. Доплата / удержание процентов ${money(i.adjustment,d.currency)}. Уже выплачено ${money(i.paid,d.currency)}, капитализировано ${money(i.capitalized,d.currency)}.`+(i.unknownHistory?' Полная история до начала учета неизвестна: показан только известный период; возврат и удержание введите вручную.':'');if(!modal.dirty&&!event&&!i.unknownHistory){form.elements.actualReturn.value=plain(i.returnAmount>0n?i.returnAmount:0n,dec);form.elements.withholding.value=plain(i.adjustment<0n?-i.adjustment:0n,dec);}}
        else{preview.textContent='Основной остаток '+money(depositBalance(s,record,date),d.currency)+'; невыплаченная оценка процентов '+money(projection.accrued,d.currency)+'. Капитализированные проценты уже входят в тело.';if(!modal.dirty&&!event)form.elements.actualInterest.value=plain(projection.accrued,dec);}};form.elements.date.addEventListener('change',update);update();
    },async(form,opts)=>{await command('deposit.close',{...values(form),id:d.id,editEventId:event?.id,confirmed:formCheck(form,'confirmed')},opts);return 'Вклад закрыт';},'Подтвердить закрытие');
  }
  function renderLoans(main){
    main.append(header('Кредиты','Основной долг, фактическая переплата и расчет будущих платежей.',owner()?[button('+ Добавить кредит',()=>loanDialog(),'primary')]:[]));if(!data.loans.length){main.append(el('section',{class:'card'},empty('Кредиты под контролем','Добавьте существующий кредит или получение нового.',owner()?button('Добавить кредит',()=>loanDialog(),'small'):null)));return;}
    const grid=el('div',{class:'contract-grid'});for(const l of data.loans){const st=loanState(data,l),rows=pendingLoanRows(data,l),over=rows.reduce((n,r)=>n+BigInt(r.interest)+BigInt(r.fees),st.arrears);grid.append(el('section',{class:'card contract-card','data-loan-id':l.id},el('div',{class:'row between'},badge(l.status==='active'?'Погашаем':l.status==='planned'?'Ожидает получения':l.status==='closed'?'Закрыт':'Отменен',l.status==='active'?'':'neutral'),el('span',{class:'hint'},l.lender)),el('h2',{},l.name),el('div',{class:'contract-amount money'},money(st.principal,l.currency)),el('p',{class:'hint'},'Основной долг · '+percentText(l.annualRate)+'% · '+(l.model==='annuity'?'аннуитет':'дифференцированный')),el('div',{class:'contract-metrics'},el('p',{},'Переплата за время учета',el('strong',{class:'money'},money(st.overpayment,l.currency))),el('p',{},'Будущая переплата · расчет',el('strong',{class:'money'},money(over,l.currency))),el('p',{},'Осталось платежей',el('strong',{},rows.length))),rows[0]?el('p',{class:'hint '+(rows[0].date<today(data)?'warning-text':'')},'Ближайший '+formatDate(rows[0].date)+(rows[0].date<today(data)?' · просрочен, штраф не рассчитан':'')):null,el('div',{class:'row wrap contract-actions'},button('График и платежи',()=>loanDetails(l),'small'),owner()&&l.status==='planned'?button('Получить кредит',()=>receiveLoanDialog(l),'small'):null,owner()&&l.status==='active'?button('Досрочно',()=>loanPaymentDialog(l,'early'),'small quiet'):null)));}main.append(grid,el('p',{class:'hint'},'Расчетный график равных месячных периодов может отличаться от банка. Фактическую разбивку можно подтвердить вручную. Долги не вычитаются из общего баланса активов.'));
  }
  function loanDialog(){if(!data.wallets.some(w=>!w.archived)){walletDialog();return;}const w=data.wallets.find(w=>!w.archived&&w.currency==='RUB')||data.wallets.find(w=>!w.archived);
    openForm('Добавить кредит','Новый кредит зачислит заемные деньги; существующий внесет только остаток долга.',(body,form)=>{body.append(field('Название *','name','',{maxlength:100}),field('Кредитор','lender','',{maxlength:100}),field('Режим','mode','existing',{choices:[['existing','Уже был на дату начала учета'],['new','Получаю новый кредит']]}),field('Кошелек *','walletId',w.id,{choices:optionsWallets()}),field('Дата выдачи / планируемого получения *','openingDate',family(data).startDate,{type:'date'}),field('Исходная сумма *','initialAmount','',{inputmode:'decimal'}),field('Основной долг сейчас / сумма нового кредита *','principal','',{inputmode:'decimal'}),field('Непогашенные проценты на начало учета','openingAccruedInterest','0',{inputmode:'decimal'}),field('Переплата до начала учета · справочно','pastOverpayment','0',{inputmode:'decimal'}),field('Годовая ставка, % *','annualRate','',{inputmode:'decimal'}),field('Модель платежей','model','annuity',{choices:[['annuity','Аннуитет'],['differentiated','Дифференцированные']]}),field('Осталось месяцев *','months','12',{type:'number',min:1,max:600}),field('Первый платеж *','firstPaymentDate',monthlyDate(nextMonth(today(data).slice(0,7)),Number(today(data).slice(8))),{type:'date'}),field('День платежа *','paymentDay',Number(today(data).slice(8)),{type:'number',min:1,max:31}),field('Регулярные комиссии / страховка','regularFee','0',{inputmode:'decimal'}),field('Комментарий','comment','',{type:'textarea',maxlength:1000}),el('div',{class:'review-box',id:'loan-create-preview'},'Укажите сумму и ставку для предварительного графика.'));
      const update=()=>{try{const currency=get(data,'wallets',formValue(form,'walletId')).currency,rows=loanSchedule(amountOf(formValue(form,'principal'),currency),formValue(form,'annualRate'),Number(formValue(form,'months')),formValue(form,'firstPaymentDate'),Number(formValue(form,'paymentDay')),formValue(form,'model'));form.querySelector('#loan-create-preview').textContent=`Расчет: первый платеж ${money(rows[0].payment,currency)}, ${rows.length} платежей, последний ${formatDate(rows.at(-1).date)}. Проценты ${money(rows.reduce((n,r)=>n+r.interest,0n),currency)} без комиссий.`;}catch{form.querySelector('#loan-create-preview').textContent='Проверьте сумму, ставку, срок и даты для предварительного графика.';}};form.addEventListener('input',update);form.addEventListener('change',update);form.elements.mode.addEventListener('change',()=>{form.elements.openingDate.value=formValue(form,'mode')==='new'?today(data):family(data).startDate;});
    },async(form,opts)=>{await command('loan.save',values(form),opts);return 'Кредит сохранен';});
  }
  function loanDetails(l,highlight=null){const st=loanState(data,l),rows=pendingLoanRows(data,l);
    openForm(l.name,'Расчетный график может отличаться от банка. Просрочка не начисляет выдуманные штрафы.',body=>{body.append(el('div',{class:'review-box'},el('h2',{class:'money'},money(st.principal,l.currency)),el('p',{},'Фактические проценты '+money(st.interest,l.currency)+' · комиссии '+money(st.fees,l.currency)),el('p',{},'Начисленные проценты на начало: '+money(st.arrears,l.currency)),el('p',{class:'hint'},'Переплата до начала учета '+money(l.pastOverpayment,l.currency)+' — справочно, без включения в текущие отчеты.')));
      if(owner()&&l.status==='planned')body.append(button('Получить кредит',()=>{closeDialog(true);receiveLoanDialog(l);},'primary small'));if(owner()&&l.status==='active')body.append(button('Досрочное погашение',()=>{closeDialog(true);loanPaymentDialog(l,'early');},'primary small'));
      body.append(el('div',{class:'form-section'},'Неоплаченные строки · '+rows.length),el('div',{class:'table-wrap contract-schedule'},el('table',{},el('thead',{},el('tr',{},['Дата','Тело','Проценты','Комиссии',''].map(x=>el('th',{},x)))),el('tbody',{},rows.map((r,i)=>el('tr',{'data-schedule-id':r.id,class:r.id===highlight?'highlight-row':''},el('td',{},formatDate(r.date),r.date<today(data)?el('div',{class:'cell-sub'},'Просрочен'):null),el('td',{class:'money'},money(r.principal,l.currency)),el('td',{class:'money'},money(BigInt(r.interest)+(i===0?st.arrears:0n),l.currency)),el('td',{class:'money'},money(r.fees,l.currency)),el('td',{},owner()&&l.status==='active'?button('Оплатить',()=>{closeDialog(true);loanPaymentDialog(l,'payment',r.id);},'small'):null)))))));contractHistory(body,'loan',l.id);
    },null,null);
  }
  function loanPaymentDialog(l,action='payment',rowId=null,goal=null,event=null){const s=editingState('loan',event),record=get(s,'loans',l.id),st=loanState(s,record),row=rowId?get(s,'loanSchedules',rowId):null,dec=get(s,'currencies',l.currency).decimals,early=action==='early';
    const reserve=goal?Object.entries(reserveBalances(s)).find(([key,a])=>key.startsWith(goal.id+'|')&&a>0n&&get(s,'wallets',key.split('|')[1]).currency===l.currency):null,walletId=event?get(data,'operations',event.operationId).walletId:reserve?.[0].split('|')[1]||l.walletId;
    openForm(early?'Досрочное погашение':'Платеж по кредиту',l.name+' · тело, проценты и комиссии учитываются раздельно.',(body,form)=>{
      body.append(field('Дата фактической оплаты *','date',event?.date||today(data),{type:'date'}),field('Кошелек *','walletId',walletId,{choices:contractWallets(l.currency)}),field('Основной долг в платеже *','principal',event?plain(event.principal,dec):early?reserve?plain(reserve[1]<st.principal?reserve[1]:st.principal,dec):'':plain(row?.principal||0,dec),{inputmode:'decimal'}),field('Проценты, включая начисленные на начало *','interest',event?plain(event.interest,dec):plain((early?0n:BigInt(row?.interest||0))+st.arrears,dec),{inputmode:'decimal'}),field('Комиссии / страховка','fees',event?plain(event.fees,dec):plain(early?0:row?.fees||0,dec),{inputmode:'decimal'}),field('Итого спишется *','amount','',{inputmode:'decimal',readonly:true}),early?field('Как изменить график','earlyMode',event?.earlyMode||'payment',{choices:[['payment','Уменьшить платеж'],['term','Уменьшить срок']]}):el('p',{class:'hint'},'Одна строка оплачивается полностью фактической разбивкой. Для дополнительного платежа используйте досрочное погашение.'),field('Новый срок, если после последней строки остался долг','newRemainingMonths','',{type:'number',min:1,max:600}),el('div',{class:'review-box',id:'loan-payment-preview'}),check('Подтверждаю разбивку и просмотр нового графика','previewConfirmed'));contractFields(body,walletId,goal?.id||'');if(reserve)form.elements.reserveAmount.value=plain(reserve[1]<st.principal?reserve[1]:st.principal,dec);if(event)body.append(field('Причина исправления *','reason','',{maxlength:300}));
      const update=()=>{form.elements.previewConfirmed.checked=false;const box=form.querySelector('#loan-payment-preview');try{const p={...values(form),rowId:early?null:rowId},principal=amountOf(p.principal,l.currency,s,true),interest=amountOf(p.interest,l.currency,s,true),fee=amountOf(p.fees,l.currency,s,true);form.elements.amount.value=plain(principal+interest+fee,dec);const changed=early||principal!==BigInt(row?.principal||0);if(changed){const preview=loanPreview(s,record,p);box.replaceChildren(el('p',{},`Старый график: ${preview.oldCount} платежей, до ${preview.oldEnd?formatDate(preview.oldEnd):'—'}, будущая переплата ${money(preview.oldOverpayment,l.currency)}.`),el('p',{},`Новый график: ${preview.newCount} платежей, до ${preview.newEnd?formatDate(preview.newEnd):'—'}, будущая переплата ${money(preview.newOverpayment,l.currency)}.`),el('p',{},'Проценты и комиссии этой операции: '+money(preview.paymentOverpayment,l.currency)),el('strong',{},'Расчетная экономия: '+money(preview.saving,l.currency)),el('details',{},el('summary',{},'Посмотреть текущий график'),pendingLoanRows(s,record).map(r=>el('div',{class:'list-row'},el('span',{class:'grow'},formatDate(r.date)),el('span',{class:'money'},money(BigInt(r.principal)+BigInt(r.interest)+BigInt(r.fees),l.currency))))),el('details',{},el('summary',{},'Посмотреть новый график'),preview.rows.map(r=>el('div',{class:'list-row'},el('span',{class:'grow'},formatDate(r.date)),el('span',{class:'money'},money(r.payment+BigInt(l.regularFee),l.currency))))));}else box.textContent='Тело совпадает с планом: будущие суммы тела и даты сохраняются. Переплата этого платежа '+money(interest+fee,l.currency)+'.';}catch(e){box.textContent=e.message;}};for(const name of ['principal','interest','fees','date','newRemainingMonths','earlyMode'])form.elements.namedItem(name)?.addEventListener('input',update);update();
    },async(form,opts)=>{await command(early?'loan.early':'loan.pay',{...contractFormValues(form),id:l.id,rowId:early?undefined:rowId,editEventId:event?.id,previewConfirmed:formCheck(form,'previewConfirmed')},opts);return 'Платеж сохранен';},'Подтвердить платеж');
  }
  function renderDebts(main){
    main.append(header('Личные долги','Обязательства и требования семьи — отдельно от заработка.',owner()?[button('+ Добавить долг',()=>debtDialog(),'primary')]:[]));
    for(const direction of ['owe','owed']){const list=data.personalDebts.filter(d=>d.direction===direction),section=el('section',{class:'debt-section'},el('h2',{},direction==='owe'?'Мы должны':'Нам должны')),grid=el('div',{class:'contract-grid'});for(const d of list){const st=debtState(data,d);grid.append(el('section',{class:'card contract-card','data-debt-id':d.id},el('div',{class:'row between'},badge(d.status==='active'?'Открыт':d.status==='closed'?'Погашен':'Отменен','neutral'),el('span',{class:'hint'},d.currency)),el('h3',{},d.counterparty),el('div',{class:'contract-amount money'},money(st.principal,d.currency)),el('p',{class:'hint'},'Проценты за время учета: '+money(st.interest,d.currency)),el('p',{class:'hint'},d.dueDate?'Срок '+formatDate(d.dueDate)+(d.dueDate<today(data)&&st.principal?' · просрочен':''):'Срок не задан'),el('div',{class:'row wrap'},button('Открыть долг',()=>debtDetails(d),'small'),owner()&&d.status==='active'?button(direction==='owe'?'Вернуть':'Получить возврат',()=>debtPaymentDialog(d),'small quiet'):null)));}section.append(list.length?grid:el('section',{class:'card'},empty(direction==='owe'?'Нет долгов семьи':'Нет требований к другим','Записи добавляются только по необходимости.')));main.append(section);}
  }
  function debtDialog(){if(!data.wallets.some(w=>!w.archived)){walletDialog();return;}
    openForm('Добавить личный долг','Тело займа — отдельное движение денег; проценты указываются при возврате.',(body,form)=>{body.append(field('Кто кому должен','direction','owe',{choices:[['owe','Мы должны'],['owed','Нам должны']]}),field('Режим','mode','existing',{choices:[['existing','Долг был на начало учета'],['new','Выдаем / получаем сейчас']]}),field('Контрагент *','counterparty','',{maxlength:100}),field('Кошелек *','walletId',data.wallets.find(w=>!w.archived).id,{choices:optionsWallets()}),field('Сумма / остаток *','principal','',{inputmode:'decimal'}),field('Дата возникновения *','openingDate',family(data).startDate,{type:'date'}),field('Срок возврата · необязательно','dueDate','',{type:'date'}),check('Включить ожидаемый возврат нам в прогноз','expectedReturn'),field('Комментарий','comment','',{type:'textarea',maxlength:1000}));contractFields(body,'');form.elements.mode.addEventListener('change',()=>form.elements.openingDate.value=formValue(form,'mode')==='new'?today(data):family(data).startDate);
    },async(form,opts)=>{await command('debt.save',{...contractFormValues(form),expectedReturn:formCheck(form,'expectedReturn')},opts);return 'Долг сохранен';});
  }
  function debtDetails(d){const st=debtState(data,d);openForm(d.counterparty,d.direction==='owe'?'Мы должны':'Нам должны',body=>{body.append(el('div',{class:'review-box'},el('h2',{class:'money'},money(st.principal,d.currency)),el('p',{},'Проценты за время учета '+money(st.interest,d.currency)),el('p',{class:'hint'},d.dueDate?'Срок '+formatDate(d.dueDate):'Дата закрытия не рассчитана: срок не задан.'),el('p',{class:'hint'},'Автоматический процентный график для личного займа не рассчитывается.')));if(owner()&&d.status==='active')body.append(el('div',{class:'row wrap'},button('Записать возврат',()=>{closeDialog(true);debtPaymentDialog(d);},'primary small'),button('Срок и ожидание',()=>{closeDialog(true);openForm('Ожидаемый возврат','Долг семьи с датой включается в обязательства; возврат нам — по явному выбору.',b=>b.append(field('Срок','dueDate',d.dueDate||'',{type:'date'}),check('Ожидать поступление в прогнозе','expectedReturn',d.expectedReturn)),async(form,opts)=>{await command('debt.expectation',{id:d.id,...values(form),expectedReturn:formCheck(form,'expectedReturn')},opts);return 'Ожидание сохранено';});},'small quiet')));contractHistory(body,'debt',d.id);},null,null);}
  function debtPaymentDialog(d,event=null){const s=editingState('debt',event),st=debtState(s,get(s,'personalDebts',d.id)),dec=get(s,'currencies',d.currency).decimals;
    openForm(d.direction==='owe'?'Вернуть личный долг':'Получить возврат займа',d.counterparty+' · частичный возврат разрешен.',body=>{body.append(field('Дата *','date',event?.date||today(data),{type:'date'}),field('Кошелек *','walletId',get(data,'operations',event?.operationId)?.walletId||d.walletId,{choices:contractWallets(d.currency)}),field('Основной долг *','principal',plain(event?.principal||st.principal,dec),{inputmode:'decimal'}),field('Проценты отдельно','interest',plain(event?.interest||0,dec),{inputmode:'decimal'}));if(d.direction==='owe')contractFields(body,d.walletId);if(event)body.append(field('Причина исправления *','reason','',{maxlength:300}));},async(form,opts)=>{await command('debt.pay',{...contractFormValues(form),id:d.id,editEventId:event?.id},opts);return 'Возврат сохранен';},'Подтвердить возврат');
  }
  function renderOperations(main){
    main.append(header('Операции','Доходы, расходы и переводы — с понятной историей.',canSubmit()?[button('+ Добавить операцию',()=>operationDialog('expense'),'primary')]:[]));
    const pending=data.proposals.filter(q=>q.status==='pending'&&(owner()||q.authorId===session.id)).length;
    main.append(el('div',{class:'tabs'},button('Все операции',()=>{operationTab='posted';render();},operationTab==='posted'?'active':''),user().role!=='viewer'?button(`Заявки${pending?' · '+pending:''}`,()=>{operationTab='proposals';render();},operationTab==='proposals'?'active':''):null));
    if(operationTab==='proposals'&&user().role!=='viewer'){renderProposals(main);return;}
    const box=el('div',{class:'filters'}),change=(name,event)=>{filters[name]=event.target.value;limit=50;render();};
    const spec=[['Поиск','search',null],['С даты','from',null],['По дату','to',null],['Тип','kind',[['','Все типы'],...Object.entries(TYPE)]],['Кошелек','walletId',[['','Все кошельки'],...data.wallets.map(w=>[w.id,w.name])]],['Категория','categoryId',[['','Все категории'],['fees','Все комиссии'],...data.categories.map(c=>[c.id,c.name])]],['Член семьи','memberId',[['','Все пометки'],['family','Вся семья'],...members().slice(1)]],['Автор','actorId',[['','Все авторы'],...data.users.map(u=>[u.id,u.displayName])]],['Статус','status',[['','Все статусы'],['posted','Проведено'],['cancelled','Отменено']]]];
    for(const [label,name,choices] of spec){const node=field(label,name,filters[name]||'',choices?{choices}:{type:['from','to'].includes(name)?'date':'search'});if(name==='search')node.classList.add('search-field');node.querySelector('input,select').addEventListener('change',event=>change(name,event));box.append(node);}
    box.append(button('Сбросить фильтры',()=>{filters={};limit=50;render();},'quiet small'));main.append(box);
    const found=latestOperations().filter(o=>{
      const lines=displayLines(o),postingId=o.status==='cancelled'?o.priorRevisionId:o.id;
      if(filters.from&&o.effectiveDate<filters.from||filters.to&&o.effectiveDate>filters.to||filters.kind&&o.businessType!==filters.kind||filters.walletId&&!data.postings.some(p=>p.operationId===postingId&&p.accountId===filters.walletId)&&o.walletId!==filters.walletId||filters.actorId&&o.actorId!==filters.actorId||filters.status&&o.status!==filters.status)return false;
      if(filters.memberId){const key=filters.memberId==='family'?'':filters.memberId;const matches=['expense','refund'].includes(o.businessType)&&lines.length?lines.some(l=>(l.memberId||'')===key):(o.memberId||'')===key;if(!matches)return false;}
      if(filters.categoryId){const cats=[o.categoryId,...lines.map(l=>l.categoryId)];if(filters.categoryId==='fees'?!cats.some(c=>['bank_fees','other_fees'].includes(c)):!cats.includes(filters.categoryId))return false;}
      if(filters.search&&!`${o.comment} ${operationLabel(o)} ${get(data,'wallets',o.walletId)?.name||''}`.toLocaleLowerCase('ru').includes(filters.search.toLocaleLowerCase('ru')))return false;return true;
    });
    main.append(el('section',{class:'card table-card'},found.length?operationTable(found.slice(0,limit)):empty('Записей пока нет','Добавьте операцию или измените фильтры.'),el('div',{class:'table-bottom row between'},el('span',{class:'hint'},`Найдено: ${found.length}`),found.length>limit?button('Показать еще',()=>{limit+=50;render();},'small'):null)));
  }
  function renderWallets(main){
    main.append(header('Кошельки','Отдельные остатки — общая картина.',owner()?[button('+ Добавить кошелек',()=>walletDialog(),'primary')]:[]));
    main.append(el('p',{class:'hint'},'Добавляйте только отдельные остатки, чтобы не посчитать одни деньги дважды.'));
    const sums=balances(data),grid=el('div',{class:'wallet-grid'});
    for(const w of data.wallets){grid.append(el('section',{class:'card wallet-tile'},el('div',{class:'row between'},el('div',{class:'row'},el('span',{class:'wallet-symbol'},w.type==='cash'?'◈':'▣'),el('div',{},el('h3',{},w.name),el('div',{class:'hint'},WALLET[w.type]+' · '+w.currency))),w.archived?badge('Архив','neutral'):null),el('div',{},el('div',{class:'wallet-total money '+(sums[w.id]<0n?'negative':'')},money(sums[w.id],w.currency)),el('div',{class:'hint'},w.liquid?'Доступен для расходов':'Отдельно от повседневных денег')),el('div',{class:'wallet-actions row wrap'},owner()?button('Изменить',()=>walletDialog(w),'small quiet'):null,owner()?button(w.archived?'Восстановить':'В архив',()=>run('wallet.archive',{id:w.id},'Кошелек обновлен'),'small quiet'):null,writer()&&!w.archived?button('Перевести',()=>operationDialog('transfer',null,{walletId:w.id}),'small'):null)));
    }
    main.append(data.wallets.length?grid:el('section',{class:'card'},empty('Здесь будут деньги семьи','Добавьте карту, наличные или валютный кошелек.',owner()?button('Создать кошелек',()=>walletDialog(),'primary'):null)));
  }
  function walletDialog(w=null){
    const used=w&&data.postings.some(p=>p.accountId===w.id);
    openForm(w?'Изменить кошелек':'Новый кошелек','Стартовый остаток — деньги именно на дату начала учета.',body=>{
      body.append(field('Ваше название *','name',w?.name||'',{maxlength:60}),el('div',{class:'form-grid'},field('Тип *','type',w?.type||'card',{choices:Object.entries(WALLET)}),field('Валюта *','currency',w?.currency||'RUB',{choices:data.currencies.map(c=>[c.code,c.code+' · '+c.displayName]),disabled:used})),field('Остаток на начало учета *','openingBalance',w?plain(w.openingBalance,get(data,'currencies',w.currency).decimals):'0',{inputmode:'decimal'}),el('p',{class:'hint'},`Дата начала: ${formatDate(family(data).startDate)}. Новые поступления после нее записывайте доходом.`),check('Доступен для текущих расходов','liquid',w?w.liquid:true),check('Основной кошелек этой валюты','primaryForCurrency',w?.primaryForCurrency||false),field('Комментарий','comment',w?.comment||'',{type:'textarea',maxlength:1000}));
      if(w)body.append(field('Причина изменения начального остатка','reason','',{hint:'Обязательна, только если меняете стартовую сумму.'}));
      if(!w){const type=body.querySelector('[name=type]');type.addEventListener('change',()=>body.querySelector('[name=liquid]').checked=type.value!=='crypto');}
    },async(form,opts)=>{await command('wallet.save',{...values(form),id:w?.id,currency:used?w.currency:formValue(form,'currency'),liquid:formCheck(form,'liquid'),primaryForCurrency:formCheck(form,'primaryForCurrency')},opts);return 'Кошелек сохранен';});
  }
  function payloadFromOperation(o){
    const d=get(data,'currencies',o.currency).decimals;const p={kind:o.businessType,walletId:o.walletId,amount:plain(o.amount,d),date:o.effectiveDate,time:o.effectiveTime,categoryId:o.categoryId,memberId:o.memberId,comment:o.comment,editId:o.id};
    if(o.businessType==='expense')p.lines=displayLines(o).map(l=>({categoryId:l.categoryId,memberId:l.memberId,amount:plain(l.amount,d)}));
    if(o.targetId){p.targetId=o.targetId;p.receivedAmount=plain(o.receivedAmount,get(data,'currencies',o.targetCurrency||o.currency).decimals);p.fxRate=o.fxRate;p.fxMode='amount';}
    if(o.fee){p.feeWalletId=o.fee.walletId;p.feeCategoryId=o.fee.categoryId;p.feeAmount=plain(o.fee.amount,get(data,'currencies',o.fee.currency).decimals);}
    if(o.businessType==='refund'){p.originalGroupId=o.links.originalGroupId;p.originalLineId=o.originalLineId;}
    const link=data.planLinks.find(l=>l.operationId===o.id&&l.status==='active');p.planId=link?.planId||'';p.planFinalize=!!link?.finalize;
    p.reserveActions=data.reserveEvents.filter(e=>e.operationId===o.id&&!e.coveragePlanId&&BigInt(e.signedAmount)<0n).map(e=>({goalId:e.goalId,walletId:e.walletId,amount:plain(-BigInt(e.signedAmount),get(data,'currencies',get(data,'wallets',e.walletId).currency).decimals),release:!!e.releaseOnly}));
    return p;
  }
  function operationDialog(kind='expense',existing=null,extra={}){
    if(!data.wallets.some(w=>!w.archived)){if(owner())walletDialog();else toast('Попросите владельца добавить кошелек.',true);return;}
    const q=extra.proposal,seed=q?.payload||(existing?payloadFromOperation(existing):{});kind=seed.kind||kind;
    const editableKinds=writer()?Object.entries(TYPE).filter(([k])=>MANUAL_TYPES.includes(k)):Object.entries(TYPE).filter(([k])=>['income','expense','refund'].includes(k));
    const primary=data.wallets.find(w=>!w.archived&&w.primaryForCurrency&&w.currency==='RUB')||data.wallets.find(w=>!w.archived);
    const initial={date:today(data),time:timeIn(data),walletId:extra.walletId||primary.id,amount:'',comment:'',...seed,...extra};
    const review=!!extra.approve,request=!!extra.request;
    const title=review?'Проверить заявку':request?'Запрос на исправление':existing?'Изменить операцию':'Добавить операцию';
    const label=review?'Одобрить и провести':request?'Отправить запрос':q?'Сохранить заявку':user().role==='contributor'?'Отправить на подтверждение':'Сохранить операцию';
    openForm(title,review?`Автор: ${personName(q.authorId)}. Проверьте данные перед проведением.`:'Деньги изменятся только после подтверждения записи.',(body,form)=>{
      const selector=field('Тип операции *','kind',kind,{choices:editableKinds,disabled:!!existing||!!q||request});body.append(selector);
      const dynamic=el('div',{});body.append(dynamic);
      const buildFields=current=>{
        dynamic.replaceChildren();const tx=current==='transfer'||current==='fx';
        dynamic.append(el('div',{class:'form-grid'},field(tx?'Счет списания *':'Кошелек *','walletId',initial.walletId,{choices:optionsWallets()}),field('Сумма *','amount',initial.amount,{inputmode:'decimal',placeholder:'0,00'})),el('div',{class:'form-grid'},field('Дата *','date',initial.date,{type:'date',min:family(data).startDate,max:today(data)}),field('Время *','time',initial.time,{type:'time'})));
        if(current==='income'||current==='expense')dynamic.append(field('Категория *','categoryId',initial.categoryId|| (current==='income'?'salary':'groceries'),{choices:optionsCategories(current,initial.categoryId)}),field('Кому относится','memberId',initial.memberId||'',{choices:members()}));
        if(current==='expense'){
          const split=check('Разделить покупку по категориям','split',!!initial.lines&&initial.lines.length>1);dynamic.append(split);const rows=el('div',{});dynamic.append(rows);const add=button('+ Еще категория',()=>addLine(),'small quiet');dynamic.append(add);
          function addLine(line={}){const row=el('div',{class:'split-line'},el('div',{class:'form-grid'},field('Категория','splitCategory',line.categoryId||'groceries',{choices:optionsCategories('expense',line.categoryId)}),field('Сумма строки','splitAmount',line.amount||'',{inputmode:'decimal'})),field('Кому относится','splitMember',line.memberId||'',{choices:members()}));row.append(button('Убрать строку',()=>{row.remove();modal.dirty=true;},'small quiet'));rows.append(row);}
          const toggle=()=>{const on=formCheck(form,'split');rows.hidden=!on;add.hidden=!on;dynamic.querySelector('[name=categoryId]').closest('.field').hidden=on;dynamic.querySelector('[name=memberId]').closest('.field').hidden=on;};
          if(initial.lines?.length>1)initial.lines.forEach(addLine);else{addLine({amount:initial.amount});addLine();}split.querySelector('input').addEventListener('change',toggle);toggle();
        }
        if(current==='refund'){
          const originals=active(data).filter(o=>o.businessType==='expense'),originalField=field('Исходная покупка *','originalGroupId',initial.originalGroupId||originals[0]?.groupId||'',{choices:originals.map(o=>[o.groupId,`${operationLabel(o)} · ${money(o.amount,o.currency)} · ${formatDate(o.effectiveDate)}`])});const lineField=field('Категория покупки *','originalLineId','',{choices:[]});
          dynamic.append(originalField,lineField,el('p',{class:'hint'},'Возврат уменьшает расходы в день получения денег. Счет должен быть в валюте покупки.'));
          const update=()=>{const o=originals.find(x=>x.groupId===formValue(form,'originalGroupId')),select=form.elements.namedItem('originalLineId');select.replaceChildren(...data.expenseLines.filter(l=>l.operationId===o?.id).map(l=>el('option',{value:l.id},`${categoryName(l.categoryId)} · ${money(l.amount,o.currency)}`)));if(initial.originalLineId)select.value=initial.originalLineId;};originalField.querySelector('select').addEventListener('change',update);update();
        }
        if(tx){
          dynamic.append(field('Счет получения *','targetId',initial.targetId||optionsWallets().find(([key])=>key!==initial.walletId)?.[0]||'',{choices:optionsWallets()}));
          if(current==='fx'){
            dynamic.append(field('Как задать обмен','fxMode',initial.fxMode||'amount',{choices:[['amount','Введу отданную и полученную суммы'],['rate','Введу отданную сумму и прямой курс']]}),field('Получено, без отдельной комиссии *','receivedAmount',initial.receivedAmount||'',{inputmode:'decimal'}),field('Прямой курс: 1 единица списания = … единиц получения','fxRate',initial.fxRate||'',{inputmode:'decimal'}),check('Также сохранить RUB-курс из этой сделки (только пара с рублем)','saveFxRate',false));
            const fxHint=el('div',{class:'review-box',id:'fx-preview'});dynamic.append(fxHint);
            const update=()=>{const from=get(data,'wallets',formValue(form,'walletId')),to=get(data,'wallets',formValue(form,'targetId')),byRate=formValue(form,'fxMode')==='rate';form.elements.namedItem('fxRate').closest('.field').hidden=!byRate;form.elements.namedItem('receivedAmount').closest('.field').hidden=byRate;
              try{const a=amountOf(formValue(form,'amount'),from.currency),r=byRate?rounded(a*parseMoney(formValue(form,'fxRate'),12)*p10(get(data,'currencies',to.currency).decimals),p10(get(data,'currencies',from.currency).decimals)*p10(12)):amountOf(formValue(form,'receivedAmount'),to.currency);fxHint.textContent=`${money(a,from.currency)} → ${money(r,to.currency)}. Курс напрямую ${from.currency} → ${to.currency}; без пересчета через RUB.`;}catch{fxHint.textContent=`Обмен напрямую ${from?.currency||'…'} → ${to?.currency||'…'}. Укажите суммы без отдельной комиссии.`;}
            };
            for(const name of ['amount','walletId','targetId','receivedAmount','fxRate','fxMode'])form.elements.namedItem(name).addEventListener('input',update);update();
          }
          dynamic.append(el('div',{class:'form-section'},'Комиссия · если была'),field('Сумма комиссии','feeAmount',initial.feeAmount||'',{inputmode:'decimal',placeholder:'0'}),field('Счет комиссии','feeWalletId',initial.feeWalletId||initial.walletId,{choices:optionsWallets()}),field('Вид комиссии','feeCategoryId',initial.feeCategoryId||'bank_fees',{choices:[['bank_fees','Банковская комиссия'],['other_fees','Прочая комиссия']]}));
        }
        if(['income','expense'].includes(current)){
          const candidates=data.plans.filter(p=>p.kind===current&&!p.module&&(planState(data,p).remaining||p.id===initial.planId));
          dynamic.append(el('div',{class:'form-section'},'Связь с планом'),field('Это исполнение плана','planId',initial.planId||'',{choices:[['','Отдельная операция'],...candidates.map(p=>[p.id,`${p.comment||categoryName(p.categoryId)} · ${formatDate(p.date)} · ${money(planState(data,p).remaining,p.currency)}`])]}),field('Если фактическая сумма меньше плана','planFinish',initial.planFinalize?'final':'part',{choices:[['part','Это часть плана, остаток еще ожидается'],['final','Закрыть план этой суммой']]}));
          const hint=el('div',{class:'notice',id:'plan-hint'});dynamic.append(hint);
          const update=()=>{const selected=get(data,'plans',formValue(form,'planId')),wallet=get(data,'wallets',formValue(form,'walletId')),similar=candidates.filter(p=>p.currency===wallet?.currency&&p.categoryId===formValue(form,'categoryId')&&Math.abs(dayNumber(p.date)-dayNumber(formValue(form,'date')))<32);hint.textContent=selected?'Остаток плана уменьшится вместе со списанием / поступлением. Другой кошелек в той же валюте разрешен.':similar.length?'Есть похожие планы: '+similar.map(p=>p.comment||categoryName(p.categoryId)).join(', ')+'. Без связи это отдельная операция; планы останутся ожидающими.':'Выберите план, если эта операция исполняет ранее заданное ожидание.';};
          for(const name of ['planId','walletId','categoryId','date'])form.elements.namedItem(name)?.addEventListener('change',update);update();
        }
        if(current==='expense'||tx){
          dynamic.append(el('div',{class:'form-section'},tx?'Перенос / освобождение резерва':'Оплата из резерва цели'));
          const state=el('div',{class:'hint'}),rows=el('div',{});dynamic.append(state,rows);
          const update=()=>{const w=get(data,'wallets',formValue(form,'walletId'));state.textContent=w?'На счете свободно '+money(balances(data)[w.id]-reservedOn(data,w.id),w.currency)+', в резервах '+money(reservedOn(data,w.id),w.currency)+'. '+(tx?'Резерв основной суммы переносится на получателя; для комиссии укажите отдельную строку.':'Выберите цель и освобождаемую сумму. Покрытие связанного плана освобождается автоматически.') :'';};form.elements.walletId.addEventListener('change',update);update();
          const add=(a={})=>{const row=el('div',{class:'reserve-action split-line'},field('Цель','actionGoalId',a.goalId||initial.reserveGoalId||'',{choices:[['','Без резерва'],...data.goals.filter(g=>g.status!=='archived').map(g=>[g.id,g.name])]}),el('div',{class:'form-grid'},field('Кошелек резерва','actionWalletId',a.walletId||initial.walletId,{choices:optionsWallets()}),field('Сумма резерва в валюте кошелька','actionAmount',a.amount||'',{inputmode:'decimal'})),tx?check('Только освободить для комиссии','actionRelease',!!a.release):null,button('Убрать резерв',()=>row.remove(),'small quiet'));rows.append(row);};
          if(initial.reserveActions?.length)initial.reserveActions.forEach(add);else add();dynamic.append(button('+ Еще резерв',()=>add(),'small quiet'));
        }
        dynamic.append(field('Комментарий','comment',initial.comment||'',{type:'textarea',maxlength:1000}));
        if(existing||request)dynamic.append(field('Причина исправления *','reason',q?.reason||'',{maxlength:300}));
        if(writer())dynamic.append(check('Разрешить списание сверх остатка','allowOverdraft',false),field('Причина отрицательного остатка','overdraftReason','',{hint:'Обязательна при явном разрешении отрицательного остатка.',maxlength:300}));
      };
      selector.querySelector('select').addEventListener('change',()=>buildFields(formValue(form,'kind')));buildFields(kind);
      if(review)body.prepend(el('div',{class:'review-box'},`Заявлено: ${TYPE[q.payload.kind]} · ${q.payload.amount} · ${get(data,'wallets',q.payload.walletId)?.name||'счет'}. ${q.payload.comment||''}`));
    },async(form,opts)=>{
      const p={...values(form),kind:existing||q?kind:formValue(form,'kind'),allowOverdraft:formCheck(form,'allowOverdraft'),saveFxRate:formCheck(form,'saveFxRate')};
      p.planFinalize=formValue(form,'planFinish')==='final';p.reserveActions=[...form.querySelectorAll('.reserve-action')].map(row=>({goalId:row.querySelector('[name=actionGoalId]').value,walletId:row.querySelector('[name=actionWalletId]').value,amount:row.querySelector('[name=actionAmount]').value,release:!!row.querySelector('[name=actionRelease]')?.checked})).filter(a=>a.goalId||a.amount);
      for(const key of ['actionGoalId','actionWalletId','actionAmount','actionRelease','planFinish'])delete p[key];
      if(['income','expense'].includes(p.kind)&&!p.planId){const wallet=get(data,'wallets',p.walletId),similar=data.plans.some(plan=>plan.kind===p.kind&&plan.currency===wallet?.currency&&plan.categoryId===p.categoryId&&planState(data,plan).remaining&&Math.abs(dayNumber(plan.date)-dayNumber(p.date))<32);if(similar&&!confirm('Похожий план остается несвязанным. Сохранить как отдельную операцию, оставив его в ожиданиях?'))throw new AppError('Выберите план в этой форме.','planId');}
      if(p.kind==='expense'&&formCheck(form,'split'))p.lines=[...form.querySelectorAll('.split-line:not(.reserve-action)')].map(row=>({categoryId:row.querySelector('[name=splitCategory]').value,amount:row.querySelector('[name=splitAmount]').value,memberId:row.querySelector('[name=splitMember]').value}));
      delete p.splitCategory;delete p.splitAmount;delete p.splitMember;
      if(existing)p.editId=existing.id;
      if(review)await command('proposal.decide',{id:q.id,approve:true,payload:p},opts);
      else if(request)await command('proposal.request',{targetId:existing.id,requestType:'edit',reason:p.reason,payload:p},opts);
      else if(q)await command('proposal.edit',{id:q.id,payload:p},opts);
      else await command('operation.save',p,opts);
      return review?'Заявка одобрена':request?'Запрос отправлен':user()?.role==='contributor'||q?'Заявка сохранена':'Операция сохранена';
    },label);
  }
  function operationDetails(o){
    openForm('Детали операции',`${TYPE[o.businessType]} · ${o.status==='posted'?'проведено':'отменено'}`,body=>{
      const lines=displayLines(o);
      body.append(el('div',{class:'review-box'},el('h2',{class:'money'},money(o.amount,o.currency)),el('div',{},`Дата: ${formatDate(o.effectiveDate)} · ${o.effectiveTime}`),el('div',{},'Счет: '+get(data,'wallets',o.walletId)?.name),el('div',{},'Автор: '+personName(o.actorId)),el('div',{},'Пометка: '+operationMemberLabel(o)),el('div',{},o.comment||'Без комментария')));
      if(o.targetId)body.append(el('p',{},`Получено ${money(o.receivedAmount,o.targetCurrency||o.currency)} на счет «${get(data,'wallets',o.targetId)?.name}».`));
      if(o.fxRate)body.append(el('p',{class:'hint'},`Фактический курс: 1 ${o.currency} = ${o.fxRate.replace(/0+$/,'').replace(/\.$/,'')} ${o.targetCurrency}.`));
      for(const l of lines)body.append(el('div',{class:'list-row'},el('span',{class:'grow'},categoryName(l.categoryId),el('span',{class:'cell-sub',style:'display:block'},memberName(l.memberId))),el('strong',{class:'money'},money(l.amount,l.currency||o.currency))));
      if(o.rubSnapshot===null||data.postings.some(p=>p.operationId===o.id&&p.rubSnapshot===null))body.append(el('div',{class:'notice warning'},'Рублевая оценка на дату операции неполная. Исходная сумма сохранена.'));
      if(o.overdraftReason)body.append(el('p',{class:'hint'},'Причина отрицательного остатка: '+o.overdraftReason));
      if(o.links?.planId){const plan=get(data,'plans',o.links.planId);body.append(el('p',{class:'hint'},'Исполнение плана: '+(plan?.comment||categoryName(plan?.categoryId))));}
      for(const c of o.incomeComponents||[])if(BigInt(c.amount))body.append(el('div',{class:'list-row'},el('span',{class:'grow'},BigInt(c.amount)<0n?'Корректировка процентного дохода':c.origin==='before_start'?'Проценты, накопленные до начала учета':'Процентный доход'),el('strong',{class:'money'},money(c.amount,c.currency))));
      if(o.links?.contract){const c=o.links.contract;body.append(button('Открыть договор',()=>{closeDialog(true);openContract(c.module,c.id);},'small'));}
      if(o.status==='posted'&&canSubmit()&&!o.links?.contract){
        const dependencies=dependentReturns(data,o),editable=mayEdit(user(),o,data)&&!dependencies;
        if(dependencies)body.append(el('div',{class:'notice warning'},'Для изменения или отмены сначала отмените связанные возвраты, начиная с последнего.'));
        body.append(el('div',{class:'row wrap',style:'margin-top:24px'},!dependencies?button(editable?'Изменить':'Запросить исправление',()=>{closeDialog(true);operationDialog(o.businessType,o,{request:!editable});},'small'):null,!dependencies?button(editable?'Отменить запись':'Запросить отмену',()=>{closeDialog(true);cancelDialog(o,!editable);},'small danger'):null,o.businessType==='expense'?button('Вернуть покупку',()=>{closeDialog(true);operationDialog('refund',null,{originalGroupId:o.groupId,walletId:o.walletId});},'small'):null));
      }
      if(owner()){
        body.append(el('div',{class:'form-section'},'История записи'));
        for(const revision of data.operations.filter(x=>x.groupId===o.groupId).sort((a,b)=>b.revision-a.revision))body.append(el('div',{class:'audit-entry'},`Версия ${revision.revision} · ${revision.status==='cancelled'?'отменена':revision.status==='superseded'?'изменена':'действует'} · ${money(revision.amount,revision.currency)}`,el('div',{class:'audit-meta'},revision.comment||'Без комментария')));
      }
    },null,null);
  }
  function cancelDialog(o,request=false){
    openForm(request?'Запросить отмену':'Отменить операцию',request?'Запрос рассмотрит владелец бюджета.':'Денежные движения будут отменены целиком, история сохранится.',body=>{
      body.append(el('div',{class:'review-box'},`${TYPE[o.businessType]}: ${money(o.amount,o.currency)}. Счет: ${get(data,'wallets',o.walletId)?.name}.`),field('Причина *','reason','',{maxlength:300}));if(!request)body.append(check('Подтверждаю возможный отрицательный остаток','allowOverdraft'),field('Причина отрицательного остатка','overdraftReason'));
    },async(form,opts)=>{if(request)await command('proposal.request',{targetId:o.id,requestType:'cancel',reason:formValue(form,'reason')},opts);else await command('operation.cancel',{id:o.id,reason:formValue(form,'reason'),allowOverdraft:formCheck(form,'allowOverdraft'),overdraftReason:formValue(form,'overdraftReason')},opts);return request?'Запрос отправлен':'Операция отменена';},request?'Отправить запрос':'Подтвердить отмену');
  }
  function renderProposals(main){
    const list=data.proposals.filter(q=>owner()||q.authorId===session.id).sort((a,b)=>Number(b.status==='pending')-Number(a.status==='pending')||b.createdAt.localeCompare(a.createdAt));
    if(!list.length){main.append(el('section',{class:'card'},empty('Заявок нет','Записи участников с подтверждением появятся здесь.')));return;}
    const labels={pending:'Ожидает решения',approved:'Одобрено',rejected:'Отклонено',withdrawn:'Отозвано'};
    for(const q of list){const current=get(data,'operations',q.targetId),p=q.payload;
      const card=el('section',{class:'card',style:'margin-bottom:16px'},el('div',{class:'row between'},el('h3',{},q.type==='create'?`${TYPE[p.kind]} · ${p.amount}`:q.type==='plan'?'Запрос изменения плана':q.type==='edit'?'Запрос на исправление':'Запрос на отмену'),badge(labels[q.status],q.status==='pending'?'warning':'neutral')),el('p',{class:'hint'},`Автор: ${personName(q.authorId)} · ${formatDate(q.createdAt.slice(0,10))}`),el('p',{},q.reason||p.comment||get(data,'wallets',p.walletId)?.name||'Без комментария'));
      if(q.decisionReason)card.append(el('p',{class:'hint'},'Причина решения: '+q.decisionReason));
      if(q.status==='pending'){
        const controls=el('div',{class:'row wrap'});
        if(owner())controls.append(button('Проверить и одобрить',()=>{if(q.type==='plan')planDialog(get(data,'plans',q.targetId),q);else if(q.type==='create')operationDialog(p.kind,null,{proposal:q,approve:true});else if(q.type==='edit')operationDialog(current?.businessType,current,{proposal:q,approve:true});else openForm('Подтвердить отмену',q.reason,body=>body.append(el('div',{class:'review-box'},`${TYPE[current?.businessType]||'Запись'} · ${current?money(current.amount,current.currency):'исходная операция изменена'}`)),async(form,opts)=>{await command('proposal.decide',{id:q.id,approve:true},opts);return 'Отмена одобрена';},'Одобрить отмену');},'primary small'),button('Отклонить',()=>openForm('Отклонить заявку','Укажите причину для автора.',body=>body.append(field('Причина *','reason','',{maxlength:300})),async(form,opts)=>{await command('proposal.decide',{id:q.id,approve:false,reason:formValue(form,'reason')},opts);return 'Заявка отклонена';},'Отклонить'),'small quiet'));
        if(q.authorId===session.id)controls.append(q.type==='create'?button('Изменить заявку',()=>operationDialog(p.kind,null,{proposal:q}),'small'):null,button('Отозвать',()=>run('proposal.withdraw',{id:q.id},'Заявка отозвана'),'small quiet'));
        card.append(controls);
      }main.append(card);
    }
  }
  function renderSettings(main){
    main.append(header('Настройки','Семья, доступы и правила вашего учета.'));
    if(!owner())settingsTab='profile';
    const tabs=owner()?[['general','Бюджет и профиль'],['rates','Валюты и курсы'],['categories','Категории'],['users','Участники'],['audit','Журнал']]:[['profile','Мой профиль']];
    main.append(el('div',{class:'tabs row wrap'},tabs.map(([key,label])=>button(label,()=>{settingsTab=key;render();},settingsTab===key?'active':''))));
    if(['general','profile'].includes(settingsTab)){
      const grid=el('div',{class:'settings-grid'});
      if(owner()){
        grid.append(el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},'Начало учета'),button('Изменить дату',familyDialog,'small quiet')),el('h3',{},formatDate(family(data).startDate)),el('p',{class:'hint'},'После первой операции дата начала фиксируется, чтобы сохранить историю.')));
        const tags=el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},'Пометки членов семьи'),button('+ Добавить',()=>memberDialog(),'small quiet')),el('p',{class:'hint'},'Кому относится покупка. Пометка не дает доступ к бюджету.'));
        for(const m of family(data).members)tags.append(el('div',{class:'list-row'},el('span',{class:'grow'},m.name),button('Переименовать',()=>memberDialog(m),'small quiet')));grid.append(tags);
      }
      grid.append(el('section',{class:'card'},el('h2',{},'Мой профиль'),el('h3',{},user().displayName),el('p',{class:'hint'},`${user().loginNormalized} · ${ROLE[user().role]}`),button('Сменить пароль',()=>passwordDialog(),'small')));
      grid.append(el('section',{class:'card'},el('h2',{},'Хранение данных'),el('p',{class:'hint'},'Бюджет хранится в этом браузере. Другой браузер или устройство не получает его автоматически. Очистка данных сайта удалит локальный бюджет.'),el('p',{class:'hint'},'Локальные роли помогают избежать случайных изменений; серверной защиты и синхронизации в этой версии нет.'),el('p',{class:'hint',id:'storage-size'},'Объем данных: подсчитываем…')));main.append(grid);
      const count=new Blob([JSON.stringify(data)]).size;document.getElementById('storage-size').textContent=`Объем записей: ${(count/1024).toFixed(1)} КБ. Экспорт и импорт в первой версии не предусмотрены.`;
    }
    if(settingsTab==='rates')renderRates(main);if(settingsTab==='categories')renderCategories(main);if(settingsTab==='users')renderUsers(main);if(settingsTab==='audit')renderAudit(main);
  }
  function familyDialog(){const f=family(data),locked=!!data.operations.length;
    openForm('Дата начала учета','Начальные остатки относятся к выбранному дню.',body=>body.append(field('Дата начала *','startDate',f.startDate,{type:'date',disabled:locked})),async(form,opts)=>{await command('family.save',{name:f.name,startDate:locked?f.startDate:formValue(form,'startDate'),timezone:f.timezone},opts);return 'Дата начала сохранена';});
  }
  function memberDialog(member){openForm('Пометка члена семьи','Используется для покупок; доступ настраивается отдельно.',body=>body.append(field('Имя *','name',member?.name||'',{maxlength:50})),async(form,opts)=>{await command('member.save',{id:member?.id,name:formValue(form,'name')},opts);return 'Пометка сохранена';});}
  function renderRates(main){
    const card=el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},'Ручные курсы к рублю'),button('+ Указать курс',()=>rateDialog(),'primary small')),el('p',{class:'hint'},'1 единица валюты = N рублей. Новые курсы меняют текущую оценку, а не историю операций.'));
    for(const c of data.currencies.filter(c=>c.code!=='RUB')){const rate=rateAt(data,c.code,today(data)),row=data.rates.filter(r=>r.currency===c.code&&r.effectiveDate<=today(data)).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0];card.append(el('div',{class:'list-row'},el('div',{class:'grow'},el('div',{class:'list-name'},c.code+' · '+c.displayName),el('div',{class:'list-meta'},row?formatDate(row.effectiveDate)+(dayNumber(today(data))-dayNumber(row.effectiveDate)>7?' · курс старше 7 дней':''):'Нет курса')),el('span',{class:'money'},rate?'1 = '+rate+' ₽':'—'),button('Указать',()=>rateDialog(c.code),'small quiet')));}
    if(data.rates.some(r=>r.effectiveDate>today(data)))card.append(el('p',{class:'hint'},'Введены будущие курсы; они будут применяться с соответствующей даты.'));
    main.append(card,el('section',{class:'card',style:'margin-top:20px'},el('div',{class:'section-head'},el('h2',{},'Валюты'),button('+ Своя валюта',currencyDialog,'small')),el('p',{class:'hint'},data.currencies.map(c=>c.code).join(' · '))));
  }
  function rateDialog(currency='USD'){openForm('Указать курс','Исходные суммы обменов и исторические оценки не изменятся.',body=>body.append(field('Валюта *','currency',currency,{choices:data.currencies.filter(c=>c.code!=='RUB').map(c=>[c.code,c.code+' · '+c.displayName])}),field('Дата действия курса *','date',today(data),{type:'date'}),field('1 единица валюты = рублей *','rate',rateAt(data,currency,today(data))||'',{inputmode:'decimal'})),async(form,opts)=>{await command('rate.save',values(form),opts);return 'Курс сохранен';});}
  function currencyDialog(){openForm('Добавить валюту','Точность будет фиксирована для этой валюты.',body=>body.append(field('Код *','code','',{maxlength:12,placeholder:'Например, CNY'}),field('Название *','displayName','',{maxlength:50}),field('Тип','kind','fiat',{choices:[['fiat','Обычная валюта'],['crypto','Криптовалюта']]}),field('Знаков после запятой *','decimals','2',{type:'number',min:0,max:18})),async(form,opts)=>{await command('currency.save',{...values(form),decimals:Number(formValue(form,'decimals'))},opts);return 'Валюта добавлена';});}
  function renderCategories(main){
    const grid=el('div',{class:'settings-grid'});
    for(const type of ['expense','income']){const card=el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},type==='expense'?'Категории расходов':'Категории доходов'),button('+ Добавить',()=>categoryDialog(null,type),'small')));
      for(const c of data.categories.filter(x=>x.type===type))card.append(el('div',{class:'list-row'},el('span',{class:'color-dot',style:`background:${c.color}`}),el('div',{class:'grow'},el('div',{class:'list-name'},c.name),c.archived?badge('Архив','neutral'):null),!c.locked?el('div',{class:'row wrap'},button('Изменить',()=>categoryDialog(c),'small quiet'),button(c.archived?'Вернуть':'В архив',()=>run('category.archive',{id:c.id},'Категория обновлена'),'small quiet'),!c.systemCode?button('Удалить',()=>{if(confirm('Удалить неиспользованную категорию «'+c.name+'»?'))run('category.delete',{id:c.id},'Категория удалена');},'small quiet'):null):badge('Системная','neutral')));grid.append(card);
    }main.append(grid);
  }
  function categoryDialog(c=null,type='expense'){openForm(c?'Изменить категорию':'Добавить категорию','Название должно быть уникально внутри типа.',body=>body.append(field('Название *','name',c?.name||'',{maxlength:60}),field('Тип *','type',c?.type||type,{choices:[['expense','Расход'],['income','Доход']],disabled:!!c}),field('Цвет','color',c?.color||PALETTE[0],{choices:PALETTE.map((color,i)=>[color,['Шалфейный','Терракотовый','Серо-синий','Песочный','Сиреневый','Бирюзовый'][i]])})),async(form,opts)=>{await command('category.save',{...values(form),id:c?.id,type:c?.type||formValue(form,'type')},opts);return 'Категория сохранена';});}
  function renderUsers(main){
    main.append(el('div',{class:'section-head'},el('h2',{},'Доступы к семейному бюджету'),button('+ Добавить участника',()=>userDialog(),'primary small')),el('p',{class:'hint'},'Для ребенка или проверяемых записей выберите роль «С подтверждением». Все профили работают в этом браузере.'));
    const card=el('section',{class:'card'});
    for(const u of data.users)card.append(el('div',{class:'list-row'},el('div',{class:'avatar'},u.displayName[0].toUpperCase()),el('div',{class:'grow'},el('div',{class:'list-name'},u.displayName),el('div',{class:'list-meta'},u.loginNormalized+' · '+ROLE[u.role])),u.status==='blocked'?badge('Заблокирован','warning'):badge('Активен'),button('Изменить',()=>userDialog(u),'small quiet'),u.role!=='owner'?button('Сбросить пароль',()=>resetPasswordDialog(u),'small quiet'):null));main.append(card);
  }
  function userDialog(u=null){openForm(u?'Изменить доступ':'Новый участник','Роль определяет действия, но все участники видят общий бюджет.',body=>{
    body.append(field('Имя *','displayName',u?.displayName||'',{maxlength:50}),field('Логин *','login',u?.loginNormalized||'',{maxlength:40}),field('Роль *','role',u?.role||'contributor',{choices:u?.role==='owner'?[['owner','Владелец']]:Object.entries(ROLE).filter(([key])=>key!=='owner'),disabled:u?.role==='owner'}));
    if(u)body.append(field('Доступ','status',u.status,{choices:u.role==='owner'?[['active','Активен']]:[['active','Активен'],['blocked','Заблокирован']]}));else body.append(field('Временный пароль *','password','',{type:'password',autocomplete:'new-password'}),field('Повторите пароль *','confirmPassword','',{type:'password',autocomplete:'new-password'}),el('p',{class:'hint'},'При первом входе участник сменит временный пароль.'));
  },async(form,opts)=>{const p={...values(form),id:u?.id,role:u?.role==='owner'?'owner':formValue(form,'role')};if(!u){checkPassword(p.password,p.confirmPassword);p.hash=await passwordHash(p.password);}delete p.password;delete p.confirmPassword;await command('user.save',p,opts);return 'Профиль сохранен';});}
  function resetPasswordDialog(u){openForm('Сбросить пароль',`Участник: ${u.displayName}. При следующем входе потребуется смена пароля.`,body=>body.append(field('Временный пароль *','password','',{type:'password',autocomplete:'new-password'}),field('Повторите пароль *','confirmPassword','',{type:'password',autocomplete:'new-password'})),async(form,opts)=>{const p=values(form);checkPassword(p.password,p.confirmPassword);await command('profile.password',{userId:u.id,hash:await passwordHash(p.password)},opts);return 'Временный пароль сохранен';});}
  function passwordDialog(required=false){openForm('Сменить пароль',required?'Перед работой задайте личный пароль вместо временного.':'Пароль действует только в этом локальном семейном пространстве.',body=>body.append(field('Текущий пароль *','oldPassword','',{type:'password',autocomplete:'current-password'}),field('Новый пароль *','password','',{type:'password',autocomplete:'new-password'}),field('Повторите новый пароль *','confirmPassword','',{type:'password',autocomplete:'new-password'})),async(form,opts)=>{
      const p=values(form);checkPassword(p.password,p.confirmPassword);const s=await readAll(),u=get(s,'users',session.id),hash=await passwordHash(p.oldPassword,u.passwordSalt);requireThat(hash.passwordHash===u.passwordHash,'Неверный текущий пароль.','oldPassword');const proof={nonce:id(),authVersion:u.authVersion};passwordProofs.set(u.id,proof);await command('profile.password',{userId:u.id,hash:await passwordHash(p.password),verificationProof:proof.nonce},opts);passwordProofs.delete(u.id);return 'Пароль изменен';
  },'Сохранить пароль',{required});}
  function renderAudit(main){
    const card=el('section',{class:'card'},el('div',{class:'section-head'},el('h2',{},'История действий'),el('span',{class:'hint'},`${data.audit.length} записей`))),list=el('div',{class:'audit-list'});
    for(const a of [...data.audit].sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,limit))list.append(el('div',{class:'audit-entry'},el('strong',{},a.summary),el('div',{class:'audit-meta'},`${personName(a.actorId)} · ${new Intl.DateTimeFormat('ru-RU',{timeZone:family(data).timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(a.timestamp))}`),a.reason?el('div',{},'Причина: '+a.reason):null,a.changedFields?el('div',{class:'hint'},Object.entries(a.changedFields).map(([key,v])=>`${key}: ${v.before??'—'} → ${v.after??'—'}`).join('; ')):null));
    card.append(list);if(data.audit.length>limit)card.append(button('Показать еще',()=>{limit+=50;render();},'small'));main.append(card);
  }
  async function init(){
    try{applyTheme(localStorage.getItem('moneyByPlan:theme')||'light');}catch{applyTheme('light');}
    if(location.protocol==='file:'||!window.isSecureContext||!window.crypto?.subtle||!window.indexedDB){fatal('Для сохранения и локального входа нужны IndexedDB, Web Crypto и безопасный адрес. Запустите страницу через localhost или HTTPS.');return;}
    try{db=await openDB();data=await readAll();view=location.hash.slice(1)||'overview';render();}
    catch(e){fatal(e.message);return;}
    if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('moneyByPlan');channel.onmessage=()=>refresh().catch(e=>toast(e.message,true));}
    else window.addEventListener('storage',event=>{if(event.key==='moneyByPlan:changed')refresh().catch(e=>toast(e.message,true));});
    window.addEventListener('hashchange',()=>{view=location.hash.slice(1);render();});
    for(const event of ['pointerdown','keydown','input'])document.addEventListener(event,()=>{if(session&&Date.now()-lastActivity>=15*60*1000)lock();lastActivity=Date.now();},{passive:true});
    setInterval(()=>{if(session&&Date.now()-lastActivity>=15*60*1000){lock();toast('Профиль заблокирован после 15 минут бездействия.');}},15000);
    setInterval(()=>{if(!document.hidden)reconcile();},60000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(session&&Date.now()-lastActivity>=15*60*1000)lock();refresh().then(()=>reconcile()).catch(e=>toast(e.message,true));}});
    // Command interface retains the same role/revision checks as every UI action.
    window.MoneyByPlan=Object.freeze({command,parseMoney,plain,money,rounded,validDate,dateIn,rateAt,inRub,balances,statistics,monthlyDate,nextMonth,convert,reserveBalances,planState,coverageLeft,goalInfo,budgetInfo,limitInfo,depositBalance,depositProjection,depositEarly,loanSchedule,loanState,loanPreview,debtState});
  }
  init();
})();
