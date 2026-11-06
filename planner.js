(function attachPlanner(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.KIGBPlanner=api;
})(typeof globalThis!=='undefined'?globalThis:window,function createPlanner(root){
  'use strict';

  const STORAGE_KEY='kigb-fit-pickup-plan-v1';
  const CONFIRMED_KEY='kigb-fit-pickup-confirmed-v1';
  const FIELDS=['unit','roomWidth','roomDepth','doorWidth','doorHeight','vehicleWidth','vehicleHeight','notes'];
  let context=null;
  let mounted=false;
  let memoryPlan=null;
  let memoryConfirmed=null;
  let storageAvailable=true;

  function number(value){
    if(value===null||value===undefined||String(value).trim()==='')return null;
    const parsed=Number(value);
    return Number.isFinite(parsed)&&parsed>0&&parsed<=100000?parsed:null;
  }

  function round(value,places=6){const factor=10**places;return Math.round(value*factor)/factor;}
  function convertLength(value,from,to){
    const parsed=number(value);
    if(parsed===null||!['in','cm'].includes(from)||!['in','cm'].includes(to))return null;
    if(from===to)return parsed;
    return round(from==='in'?parsed*2.54:parsed/2.54);
  }

  function parseListedDimensions(raw,labelStatus='unlabeled'){
    const source=typeof raw==='string'?raw.trim():'';
    if(!source)return {raw:'',values:[],axes:{},unit:null,labelStatus:'missing',comparable:false};
    const unsupportedFraction=/\d+\s+\d+\/\d+|\d+\/\d+/.test(source);
    const unsupportedFeet=/\d\s*[′’']/.test(source);
    const hasCm=/\b(?:cm|centimet(?:er|re)s?)\b/i.test(source);
    const hasIn=/[″”"]|\b(?:inch|inches)\b|\d(?:\.\d+)?\s*in\b/i.test(source);
    const mixedUnits=hasCm&&hasIn;
    const unsupported=unsupportedFraction||unsupportedFeet||mixedUnits;
    const values=unsupported?[]:[...source.matchAll(/\d+(?:\.\d+)?/g)].map(match=>Number(match[0])).filter(value=>Number.isFinite(value)&&value>0);
    const axes={};
    for(const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(?:(?:[″”"]|in(?:ches?)?|cm|centimet(?:er|re)s?)\s*)?([WDH])\b/gi)){
      const axis={w:'width',d:'depth',h:'height'}[match[2].toLowerCase()];
      if(axes[axis]===undefined)axes[axis]=Number(match[1]);
    }
    const unit=unsupported?null:hasCm?'cm':hasIn?'in':null;
    return {raw:source,values,axes:unsupported?{}:axes,unit,labelStatus,unsupported,comparable:values.length>0&&unit!==null};
  }

  function normalizePlan(value={}){
    const unit=value.unit==='cm'?'cm':'in';
    const plan={unit,notes:typeof value.notes==='string'?value.notes.slice(0,2000):''};
    for(const field of FIELDS.slice(1,-1))plan[field]=number(value[field]);
    return plan;
  }

  function convertPlan(plan,nextUnit){
    const normalized=normalizePlan(plan);
    if(!['in','cm'].includes(nextUnit)||nextUnit===normalized.unit)return {...normalized,unit:nextUnit||normalized.unit};
    const converted={...normalized,unit:nextUnit};
    for(const field of FIELDS.slice(1,-1))converted[field]=convertLength(normalized[field],normalized.unit,nextUnit);
    return converted;
  }

  function normalizeConfirmed(value={}){
    return {unit:value.unit==='cm'?'cm':'in',width:number(value.width),depth:number(value.depth),height:number(value.height)};
  }

  function readConfirmed(){
    if(memoryConfirmed)return {...memoryConfirmed};
    try{
      const storage=root.sessionStorage;if(!storage)throw new Error('Session storage unavailable');
      const raw=JSON.parse(storage.getItem(CONFIRMED_KEY)||'{}'),result={};
      if(!raw||typeof raw!=='object'||Array.isArray(raw)){memoryConfirmed=result;return {...result};}
      for(const [handle,value] of Object.entries(raw))if(/^[a-z0-9][a-z0-9-]{0,254}$/.test(handle))result[handle]=normalizeConfirmed(value);
      memoryConfirmed=result;return {...result};
    }catch{storageAvailable=false;memoryConfirmed={};return {};}
  }

  function saveConfirmed(value){
    memoryConfirmed={...value};
    try{const storage=root.sessionStorage;if(!storage)throw new Error('Session storage unavailable');storage.setItem(CONFIRMED_KEY,JSON.stringify(memoryConfirmed));storageAvailable=true;return true;}catch{storageAvailable=false;return false;}
  }

  function confirmedDimensions(value){
    const confirmed=normalizeConfirmed(value),axes={};
    for(const axis of ['width','depth','height'])if(confirmed[axis]!==null)axes[axis]=confirmed[axis];
    const values=Object.values(axes);
    return values.length===3?{raw:values.map(amount=>`${amount} ${confirmed.unit}`).join(' × '),values,axes,unit:confirmed.unit,labelStatus:'labeled',comparable:true,source:'shopper-confirmed'}:null;
  }

  function formatLength(value,unit){
    const parsed=number(value);
    return parsed===null?'Not entered':`${round(parsed,2)} ${unit==='cm'?'cm':'in'}`;
  }

  function evaluateRoute(product,planValue,confirmedValue){
    const plan=normalizePlan(planValue);
    const confirmed=normalizeConfirmed(confirmedValue),confirmedCount=['width','depth','height'].filter(axis=>confirmed[axis]!==null).length;
    const parsed=confirmedDimensions(confirmed)||parseListedDimensions(product?.dimensionsRaw,product?.dimensions?.labelStatus);
    const checks=[];
    const openingGroups=[['doorWidth','doorHeight','doorway'],['vehicleWidth','vehicleHeight','vehicle opening']];
    const hasRoom=plan.roomWidth!==null||plan.roomDepth!==null;
    const hasOpening=openingGroups.some(([width,height])=>plan[width]!==null||plan[height]!==null);
    if(confirmedCount>0&&confirmedCount<3)return {kind:'confirm',title:'Complete your confirmed measurements',checks:['Enter confirmed width, depth, and height before comparing this piece. Partial measurements stay saved but do not produce a route result.'],parsed:{...parsed,source:'shopper-confirmed-partial'}};
    if(!parsed.raw)return {kind:'missing',title:'Measurements needed',checks:['The listing does not supply measurements. Ask the gallery before planning transport.'],parsed};
    if(!parsed.comparable||parsed.labelStatus!=='labeled'||!['width','depth','height'].every(axis=>number(parsed.axes[axis])!==null))return {kind:'confirm',title:'Confirm all three dimensions',checks:['The store listing does not clearly label width, depth, height, and units. Confirm all three with the gallery, then enter them above for a cautious comparison.'],parsed};
    if(!hasRoom&&!hasOpening)return {kind:'empty',title:'Add your measurements',checks:['Enter the room and both dimensions of each tight opening you know. Then confirm clearance, stairs, turns, orientation, and handling with the gallery.'],parsed};
    const sideValues=[parsed.axes.width,parsed.axes.depth,parsed.axes.height];
    if(plan.roomWidth!==null&&plan.roomDepth!==null){
      const roomWidth=convertLength(plan.roomWidth,plan.unit,parsed.unit),roomDepth=convertLength(plan.roomDepth,plan.unit,parsed.unit);
      const direct=parsed.axes.width<=roomWidth&&parsed.axes.depth<=roomDepth,rotated=parsed.axes.depth<=roomWidth&&parsed.axes.width<=roomDepth;
      if(!direct&&!rotated)checks.push(`The listed ${formatLength(parsed.axes.width,parsed.unit)} × ${formatLength(parsed.axes.depth,parsed.unit)} footprint is larger than the entered room footprint in both simple orientations. Recheck usable floor space and placement.`);
    }else if(hasRoom)checks.push('Enter both room width and room depth to compare the listed footprint.');
    for(const [widthField,heightField,label] of openingGroups){
      const width=plan[widthField],height=plan[heightField];
      if(width===null&&height===null)continue;
      if(width===null||height===null){checks.push(`Enter both ${label} width and height before comparing the route.`);continue;}
      const openingWidth=convertLength(width,plan.unit,parsed.unit),openingHeight=convertLength(height,plan.unit,parsed.unit);
      const pairs=[[0,1],[0,2],[1,2]];
      const simplePairFits=pairs.some(([a,b])=>(sideValues[a]<=openingWidth&&sideValues[b]<=openingHeight)||(sideValues[b]<=openingWidth&&sideValues[a]<=openingHeight));
      if(!simplePairFits)checks.push(`None of the three simple side-pair orientations falls within the entered ${label} of ${formatLength(width,plan.unit)} × ${formatLength(height,plan.unit)}. Tilting, shape, packaging, turns, and handling can change what is possible; confirm with the gallery or mover.`);
    }
    return {kind:checks.length?'check':'review',title:checks.length?'Measurements to check':'No simple conflict flagged',checks:checks.length?checks:['The listed rectangular dimensions fall within at least one simple orientation for each complete opening entered. This is not a fit guarantee—confirm clearances, shape, stairs, turns, and handling.'],parsed};
  }

  function planLine(label,value,unit){return `${label}: ${formatLength(value,unit)}`;}
  function buildWorksheet({plan:planValue={},products=[],confirmedByProduct={},inventoryStatus=''}={}){
    const plan=normalizePlan(planValue);
    const pieces=products.filter(product=>!/gift.?card/i.test((product.sourceProductType||'')+' '+(product.title||'')));
    const lines=[
      'KISS IT GOOD BUY — FIT & PICKUP PLAN',
      '201 East Franklin Street · Grapevine, TX 76051 · 817-481-9754',
      'Tue–Sat 10:30–6 · Sun 12–5',
      '',
      'MY SPACE & ROUTE',
      planLine('Room width',plan.roomWidth,plan.unit),
      planLine('Room depth',plan.roomDepth,plan.unit),
      planLine('Smallest doorway width',plan.doorWidth,plan.unit),
      planLine('Smallest doorway height',plan.doorHeight,plan.unit),
      planLine('Vehicle opening width',plan.vehicleWidth,plan.unit),
      planLine('Vehicle opening height',plan.vehicleHeight,plan.unit),
      `Notes: ${plan.notes||'None entered'}`,
      '',
      'SAVED PIECES'
    ];
    if(!pieces.length)lines.push('No furniture or decor is currently in this plan.');
    for(const product of pieces){
      const confirmed=confirmedByProduct[product.handle],evaluation=evaluateRoute(product,plan,confirmed);
      lines.push('',product.title||'Untitled piece');
      lines.push(`Item: ${product.itemNumber||'Ask the gallery'}`);
      lines.push(`Listed measurements: ${product.dimensionsRaw||'Not supplied'}`);
      const own=confirmedDimensions(confirmed);
      if(own)lines.push(`Measurements I confirmed with the gallery: ${Object.entries(own.axes).map(([axis,value])=>`${axis} ${formatLength(value,own.unit)}`).join(' · ')}`);
      lines.push(`Availability: ${product.available?'Shown as available at last check':'Unavailable at last check'}`);
      lines.push(`Review: ${evaluation.checks.join(' ')}`);
      if(product.productUrl)lines.push(`Store listing: ${product.productUrl}`);
    }
    lines.push('',inventoryStatus||'Recheck current availability before making a special trip.');
    lines.push('Planning aid only. Saving a piece does not hold or reserve it. Confirm current availability, condition, measurements, dimension order, pickup timing, and transport with the gallery.');
    return lines.join('\n');
  }

  function readPlan(){
    if(memoryPlan)return {...memoryPlan};
    try{const storage=root.sessionStorage;if(!storage)throw new Error('Session storage unavailable');memoryPlan=normalizePlan(JSON.parse(storage.getItem(STORAGE_KEY)||'{}'));}catch{storageAvailable=false;memoryPlan=normalizePlan();}
    return {...memoryPlan};
  }
  function savePlan(plan){
    memoryPlan=normalizePlan(plan);
    try{const storage=root.sessionStorage;if(!storage)throw new Error('Session storage unavailable');storage.setItem(STORAGE_KEY,JSON.stringify(memoryPlan));storageAvailable=true;return true;}catch{storageAvailable=false;return false;}
  }
  function formPlan(form){
    const data=new root.FormData(form),value={};
    for(const field of FIELDS)value[field]=data.get(field);
    return normalizePlan(value);
  }
  function inputValue(value){return value===null||value===undefined?'':String(value);}

  function formMarkup(plan){
    const unitLabel=plan.unit==='cm'?'centimeters':'inches';
    const field=(name,label,help)=>`<label class="planner-field"><span>${label}</span><input name="${name}" type="number" min="0.1" max="100000" step="any" inputmode="decimal" value="${inputValue(plan[name])}" aria-describedby="${name}-help"><small id="${name}-help">${help} · ${unitLabel}</small></label>`;
    return `<form id="fit-plan-form" class="planner-form"><div class="planner-unit"><span>Measure in</span><div role="group" aria-label="Measurement unit"><button type="button" data-plan-unit="in" aria-pressed="${plan.unit==='in'}">Inches</button><button type="button" data-plan-unit="cm" aria-pressed="${plan.unit==='cm'}">Centimeters</button></div><input type="hidden" name="unit" value="${plan.unit}"></div><fieldset><legend>The room</legend><div class="planner-field-grid">${field('roomWidth','Room width','Wall to wall')}${field('roomDepth','Room depth','Wall to wall')}</div></fieldset><fieldset><legend>The route in</legend><div class="planner-field-grid">${field('doorWidth','Smallest doorway width','Clear opening, trim to trim')}${field('doorHeight','Smallest doorway height','Clear opening, floor to trim')}${field('vehicleWidth','Vehicle opening width','Clear hatch, door, or cargo opening')}${field('vehicleHeight','Vehicle opening height','Clear hatch, door, or cargo opening')}</div></fieldset><label class="planner-notes"><span>Turns, stairs, elevator & pickup notes</span><textarea name="notes" maxlength="2000" rows="5" placeholder="Add tight turns, stair widths, elevator size, vehicle details, or questions for the gallery.">${context.esc(plan.notes)}</textarea><small>Saved in this tab. Notes are excluded from public links and included when you copy or print the plan.</small></label><div class="planner-form-status"><p class="planner-save-status" role="status">${storageAvailable?'Saved in this tab as you type.':'Browser storage is unavailable; kept until this page closes.'}</p><button class="text-link" type="button" data-clear-plan>Clear measurements & notes</button></div></form>`;
  }

  function confirmedForm(product,confirmed){
    const count=['width','depth','height'].filter(axis=>confirmed[axis]!==null).length;
    const fields=['width','depth','height'].map(axis=>`<label><span>${axis[0].toUpperCase()+axis.slice(1)}</span><input name="${axis}" type="number" min="0.1" max="100000" step="any" inputmode="decimal" value="${inputValue(confirmed[axis])}"></label>`).join('');
    return `<details class="planner-confirmed" ${count?'open':''}><summary>Measurements you confirmed with the gallery${count?` · ${count} of 3 entered`:''}</summary><form data-confirmed-piece="${context.esc(product.handle)}"><label><span>Units</span><select name="unit"><option value="in" ${confirmed.unit==='in'?'selected':''}>Inches</option><option value="cm" ${confirmed.unit==='cm'?'selected':''}>Centimeters</option></select></label>${fields}<small>Optional. Enter all three measurements only after you personally confirm them with the gallery. They are saved in this tab and kept separate from the store listing.</small></form></details>`;
  }

  function piecesMarkup(){
    const products=context.shortlistItems().filter(product=>!/gift.?card/i.test((product.sourceProductType||'')+' '+product.title));
    if(!products.length)return `<div class="planner-empty"><span>01</span><div><h2>Save a piece to begin.</h2><p>Use the heart on furniture or decor, then return here to compare its listed measurements with your room and route.</p><a class="button red" href="collection.html">Explore the finds →</a></div></div>`;
    const plan=readPlan(),confirmedByProduct=readConfirmed();
    const cards=products.map((product,index)=>{
      const confirmed=confirmedByProduct[product.handle]||normalizeConfirmed(),result=evaluateRoute(product,plan,confirmed);
      const photoLabel=product.images.length?`View ${context.esc(product.displayTitle)}`:`View details for ${context.esc(product.displayTitle)}; photograph not supplied`;
      return `<article class="planner-piece">
        <a class="planner-piece-photo" href="${context.productHref(product)}" aria-label="${photoLabel}"><img src="${context.thumb(product.image,500)}" alt="${product.images.length?context.esc(product.displayTitle):''}" width="280" height="280"></a>
        <div class="planner-piece-copy">
          <p class="eyebrow">0${index+1} / ${product.itemNumber?'ITEM '+context.esc(product.itemNumber):'GALLERY FIND'}</p>
          <h2><a href="${context.productHref(product)}">${context.esc(product.displayTitle)}</a></h2>
          <p class="planner-listed"><strong>Store listing</strong><span>${context.esc(product.dimensionsRaw||'Measurements not supplied')}</span>${product.dimensions?.labelStatus!=='labeled'&&product.dimensionsRaw?'<small>Order or units are not fully labeled. Confirm them with the gallery.</small>':''}</p>
          ${confirmedForm(product,confirmed)}
          <div class="planner-review ${result.kind}"><strong>${result.title}</strong><p>${context.esc(result.checks.join(' '))}</p>${result.parsed.source==='shopper-confirmed'?'<small>Comparison uses all three measurements you entered above.</small>':''}</div>
          <div class="planner-piece-links"><a class="text-link" href="${context.productHref(product)}">${product.images.length} ${product.images.length===1?'photograph':'photographs'} & details →</a><span class="stock-label ${product.available?'':'sold-out'}">${product.available?'Available at last check':'Unavailable at last check'}</span></div>
        </div>
      </article>`;
    });
    return `<div class="planner-piece-list">${cards.join('')}</div>`;
  }

  function updatePrintSummary(){
    const summary=root.document?.querySelector('#planner-print-summary');
    if(!summary)return;
    summary.textContent=buildWorksheet({plan:readPlan(),products:context.shortlistItems(),confirmedByProduct:readConfirmed(),inventoryStatus:context.inventoryStatus()});
  }

  function updatePieceList(focusHandle,focusName){
    const target=root.document?.querySelector('#planner-pieces');
    if(target)target.innerHTML=piecesMarkup();
    const status=root.document?.querySelector('[data-planner-inventory]');
    if(status)status.textContent=context.inventoryStatus();
    updatePrintSummary();
    if(focusHandle&&focusName)target?.querySelector(`[data-confirmed-piece="${focusHandle}"] [name="${focusName}"]`)?.focus();
  }

  function updateUnit(form,nextUnit){
    const current=formPlan(form),converted=convertPlan(current,nextUnit);
    for(const field of FIELDS.slice(1,-1)){
      const input=form.elements[field];
      if(input)input.value=inputValue(converted[field]);
    }
    form.elements.unit.value=converted.unit;
    for(const button of form.querySelectorAll('[data-plan-unit]'))button.setAttribute('aria-pressed',String(button.dataset.planUnit===converted.unit));
    for(const help of form.querySelectorAll('.planner-field small'))help.textContent=help.textContent.replace(/ · (?:inches|centimeters)$/,` · ${converted.unit==='cm'?'centimeters':'inches'}`);
    savePlan(converted);
    updatePieceList();
  }

  function mount(nextContext){
    if(nextContext)context=nextContext;
    const target=root.document?.querySelector('#planner-app');
    if(!target||!context||mounted)return false;
    mounted=true;
    const plan=readPlan();
    target.innerHTML=`<div class="planner-workspace"><section class="planner-measurements" aria-labelledby="measure-plan-title"><div class="planner-section-heading"><p class="eyebrow">01 / Measure once</p><h2 id="measure-plan-title">Your room.<br><em>Your route in.</em></h2><p>Record the tightest openings you know. The comparison flags measurements worth checking; it never promises a piece will fit.</p></div>${formMarkup(plan)}</section><section class="planner-selection" aria-labelledby="saved-plan-title"><div class="planner-section-heading planner-selection-heading"><div><p class="eyebrow">02 / Your possibilities</p><h2 id="saved-plan-title">Saved pieces,<br><em>ready to plan.</em></h2></div><p data-planner-inventory role="status">${context.inventoryStatus()}</p></div><div id="planner-pieces">${piecesMarkup()}</div></section><section class="planner-pickup" aria-labelledby="pickup-plan-title"><div><p class="eyebrow">03 / Make the trip useful</p><h2 id="pickup-plan-title">A pickup plan<br>you can take with you.</h2><p>Bring item numbers, route measurements, and questions together. Call ahead before a special trip; saving a piece is never a hold or reservation.</p></div><div class="planner-pickup-card"><strong>201 E. Franklin Street</strong><span>Grapevine, Texas 76051</span><span>Tue–Sat 10:30–6 · Sun 12–5</span><a href="tel:+18174819754">817-481-9754</a><div><button class="button red" type="button" data-copy-plan>Copy my plan</button><button class="button outline" type="button" data-print-plan>Print my plan</button></div></div></section></div><pre id="planner-print-summary" class="planner-print-summary" aria-hidden="true"></pre>`;
    const form=target.querySelector('#fit-plan-form');
    const status=()=>{const output=form.querySelector('.planner-save-status');if(output)output.textContent=storageAvailable?'Saved in this tab as you type.':'Browser storage is unavailable; kept until this page closes.';};
    const fillForm=value=>{
      for(const field of FIELDS.slice(1,-1))form.elements[field].value=inputValue(value[field]);
      form.elements.notes.value=value.notes;
      form.elements.unit.value=value.unit;
      for(const button of form.querySelectorAll('[data-plan-unit]'))button.setAttribute('aria-pressed',String(button.dataset.planUnit===value.unit));
    };
    form.addEventListener('input',()=>{savePlan(formPlan(form));status();updatePieceList();});
    target.addEventListener('submit',event=>{
      if(event.target.matches('#fit-plan-form,[data-confirmed-piece]'))event.preventDefault();
    });
    target.addEventListener('change',event=>{
      const pieceForm=event.target.closest('[data-confirmed-piece]');
      if(!pieceForm)return;
      const all=readConfirmed(),handle=pieceForm.dataset.confirmedPiece,previous=normalizeConfirmed(all[handle]),data=new root.FormData(pieceForm);
      let value=normalizeConfirmed(Object.fromEntries(data.entries()));
      if(event.target.name==='unit'&&previous.unit!==value.unit){
        for(const axis of ['width','depth','height'])value[axis]=convertLength(previous[axis],previous.unit,value.unit);
      }
      if(['width','depth','height'].some(axis=>value[axis]!==null))all[handle]=value;else delete all[handle];
      saveConfirmed(all);
      status();
      updatePieceList(handle,event.target.name);
    });
    target.addEventListener('click',event=>{
      const unit=event.target.closest('[data-plan-unit]');
      if(unit){updateUnit(form,unit.dataset.planUnit);return;}
      if(event.target.closest('[data-clear-plan]')){
        memoryPlan=normalizePlan();memoryConfirmed={};
        try{const storage=root.sessionStorage;if(!storage)throw new Error('Session storage unavailable');storage.removeItem(STORAGE_KEY);storage.removeItem(CONFIRMED_KEY);storageAvailable=true;}catch{storageAvailable=false;}
        fillForm(memoryPlan);status();updatePieceList();context.toast?.('Measurements and notes cleared from this tab.');return;
      }
      if(event.target.closest('[data-print-plan]')){savePlan(formPlan(form));status();updatePrintSummary();root.print();return;}
      if(event.target.closest('[data-copy-plan]')){
        const text=buildWorksheet({plan:formPlan(form),products:context.shortlistItems(),confirmedByProduct:readConfirmed(),inventoryStatus:context.inventoryStatus()});
        context.copyText(text,'Fit & pickup plan copied.');
      }
    });
    updatePrintSummary();
    return true;
  }

  function refresh(){if(!mounted)return root.KIGBPlannerContext?mount(root.KIGBPlannerContext):false;updatePieceList();return true;}
  if(root.addEventListener)root.addEventListener('kigb:planner-ready',()=>mount(root.KIGBPlannerContext));
  if(root.document&&root.KIGBPlannerContext)mount(root.KIGBPlannerContext);

  return {STORAGE_KEY,CONFIRMED_KEY,number,convertLength,parseListedDimensions,normalizePlan,normalizeConfirmed,convertPlan,evaluateRoute,buildWorksheet,mount,refresh};
});
