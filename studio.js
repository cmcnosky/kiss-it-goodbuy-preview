(function attachStudio(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.KIGBStudio=api;
})(typeof globalThis!=='undefined'?globalThis:window,function createStudio(root){
  'use strict';

  // Shared preview access only; this static site does not provide server authentication.
  const SESSION_KEY='kigb-owner-studio-session-v1';
  let volatileSignIn=false,sessionInMemory=false;
  function signedIn(){
    if(sessionInMemory)return volatileSignIn;
    try{if(!root.sessionStorage)return false;return root.sessionStorage.getItem(SESSION_KEY)==='Chelsea';}catch{return volatileSignIn;}
  }
  function setSignedIn(value){
    volatileSignIn=value;
    try{
      if(!root.sessionStorage)throw new Error('Session storage unavailable');
      if(value)root.sessionStorage.setItem(SESSION_KEY,'Chelsea');else root.sessionStorage.removeItem(SESSION_KEY);
      sessionInMemory=value?root.sessionStorage.getItem(SESSION_KEY)!=='Chelsea':false;
    }catch{sessionInMemory=true;}
  }
  function loginMarkup(message=''){
    return `<section class="studio-login"><div class="studio-login-welcome"><p class="eyebrow">Kiss It Good Buy · Owner Studio</p><h1>Welcome,<br><em>Chelsea.</em></h1><p>Your space to try a new look, explore the store, and keep the ideas you love.</p><span>Change a little. Try something bold. Come back to it later.</span></div><div class="studio-login-card"><p class="eyebrow">Make yourself at home</p><h2>Open your workspace.</h2><form id="studio-login-form" method="dialog"><label for="studio-username">Login</label><input id="studio-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="100"><label for="studio-password">Password</label><input id="studio-password" name="password" type="password" autocomplete="current-password" required maxlength="100"><label class="studio-show-password"><input type="checkbox" data-show-studio-password> Show password</label><p id="studio-login-error" role="alert" ${message?'':'hidden'}>${escape(message)}</p><button type="submit" class="button red">Sign in to Owner Studio →</button></form><p class="studio-login-note">This shared preview sign-in is a convenience, not a secure business account. Your saved edits stay on this browser.</p><a class="text-link" href="index.html">Back to the storefront →</a></div></section>`;
  }

  const TABS=['design','content','inventory','versions','orders','activity'];
  const PRESETS={
    original:{label:'Gallery original',design:{coral:'#e58a78',celadon:'#bfd9b7',ochre:'#edc56b',cream:'#fff9ed',ink:'#2d2927',frame:'#8f2f28'}},
    collected:{label:'Collected color',design:{coral:'#de755f',celadon:'#b9d8c0',ochre:'#f0c65e',cream:'#fff8e9',ink:'#282321',frame:'#873228'}},
    twilight:{label:'Gallery twilight',design:{coral:'#c77468',celadon:'#a8c9b7',ochre:'#dcb35d',cream:'#f7f0df',ink:'#27252d',frame:'#633445'}},
    mineral:{label:'Mineral & linen',design:{coral:'#cf806f',celadon:'#b7c9b9',ochre:'#d5b56c',cream:'#faf5e9',ink:'#292c2c',frame:'#6f4139'}}
  };
  let context=null;
  let unsubscribe=null;
  let mounted=false;
  let pendingConfirm=null;
  const ui={tab:'design',search:'',message:'',messageKind:'status',inventoryPage:1,loginMessage:''};

  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((Number(cents)||0)/100);
  const date=value=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value));
  const stateApi=()=>root.KIGBStudioState;
  const baseProducts=()=>Array.isArray(context?.inventory?.products)?context.inventory.products:[];
  const current=()=>stateApi()?.read();

  function render(){
    return '<main id="main" class="owner-studio"><div id="studio-app">'+loginMarkup()+'</div><noscript><p class="studio-login-note">Enable JavaScript to sign in and use the Owner Studio.</p></noscript></main>';
  }

  function statusText(){
    const status=stateApi().getStatus();
    if(status.conflict)return 'Another tab has newer Studio changes. Reload before editing.';
    if(!status.persisted)return 'Browser storage is unavailable. Changes are kept only until this page closes.';
    return `Saved on this browser · revision ${status.revision}`;
  }

  function tabFromUrl(){
    try{const value=new URL(root.location.href).searchParams.get('tab');return TABS.includes(value)?value:'design';}catch{return 'design';}
  }

  function setTab(tab){
    if(!TABS.includes(tab))return;
    ui.tab=tab;
    try{const url=new URL(root.location.href);if(tab==='design')url.searchParams.delete('tab');else url.searchParams.set('tab',tab);root.history.replaceState(null,'',url);}catch{}
    renderApp();
  }

  function headerMarkup(state){
    const status=stateApi().getStatus();
    return `<header class="studio-top">
      <div class="studio-title"><p class="eyebrow">Kiss It Good Buy · Owner Studio</p><h1>Try it. Save it.<br><em>Change it back.</em></h1><p>Design and practice on this browser. The real Shopify catalog, checkout, customers, and orders stay untouched.</p></div>
      <div class="studio-actions">
        <p class="studio-persistence ${status.persisted?'saved':'warning'}" role="status"><span></span>${escape(statusText())}</p>
        <button class="button red" type="button" data-preview-store>Preview my storefront →</button>
        <button class="button outline" type="button" data-return-original>Return to original</button><div class="studio-session"><span>Signed in as Chelsea${sessionInMemory?' · this page only':''}</span><button type="button" data-studio-signout>Sign out</button></div>
      </div>
    </header>`;
  }

  function navMarkup(state){
    const counts={inventory:baseProducts().length+state.draft.customProducts.length,versions:state.versions.length,orders:state.orders.length,activity:state.messages.length};
    return `<nav class="studio-tabs" aria-label="Owner Studio sections">${[
      ['design','Design'],['content','Words & contact'],['inventory','Inventory'],['versions','Saved versions'],['orders','Practice orders'],['activity','Practice activity']
    ].map(([id,label])=>`<button type="button" data-studio-tab="${id}" aria-current="${ui.tab===id?'page':'false'}">${label}${counts[id]!==undefined?` <span>${counts[id]}</span>`:''}</button>`).join('')}</nav>`;
  }

  function previewMarkup(draft){
    const d=draft.design,c=draft.content,products=baseProducts().map(product=>effectiveProduct(product,draft)).filter(product=>!product.hidden&&product.imageUrl).slice(0,3);
    const style=`--preview-coral:${d.coral};--preview-sage:${d.celadon};--preview-gold:${d.ochre};--preview-cream:${d.cream};--preview-ink:${d.ink};--preview-frame:${d.frame};--preview-border:${d.borderWidth}px;--preview-scale:${d.textScale};`;
    return `<aside class="studio-live-preview" style="${style}" aria-label="Design preview">
      <div class="studio-preview-copy"><span>LIVE PREVIEW</span><h3>${escape(c.heroTitle)}<br><em>${escape(c.heroAccent)}</em></h3><p>${escape(c.heroIntro).replaceAll('\n','<br>')}</p><span class="studio-preview-button">Explore the finds →</span></div>
      <div class="studio-preview-products">${products.map(product=>`<figure><img src="${escape(product.imageUrl)}" alt=""><figcaption>${escape(product.title)}</figcaption></figure>`).join('')}</div>
    </aside>`;
  }

  function designPanel(state){
    const design=state.draft.design;
    const colors=[['coral','Coral'],['celadon','Celadon'],['ochre','Ochre'],['cream','Cream'],['ink','Ink'],['frame','Frame']];
    const select=(name,label,options)=>`<label class="studio-field"><span>${label}</span><select name="${name}" data-design-field>${options.map(([value,text])=>`<option value="${value}" ${design[name]===value?'selected':''}>${text}</option>`).join('')}</select></label>`;
    return `<section class="studio-panel design-panel" aria-labelledby="design-title">
      <div class="studio-panel-heading"><p class="eyebrow">Design</p><h2 id="design-title">Shape the feeling.</h2><p>Start with a complete palette, then tune type, spacing, borders, photography, and the home-page composition.</p></div>
      <div class="studio-preset-grid">${Object.entries(PRESETS).map(([id,preset])=>`<button type="button" data-preset="${id}"><span class="preset-swatches">${Object.values(preset.design).slice(0,4).map(color=>`<i style="background:${color}"></i>`).join('')}</span><strong>${preset.label}</strong></button>`).join('')}</div>
      <div class="studio-design-grid">
        <fieldset class="studio-card"><legend>Color palette</legend><div class="studio-colors">${colors.map(([name,label])=>`<label><span>${label}</span><div><input type="color" value="${design[name]}" data-color-picker="${name}" aria-label="Choose ${label} color"><input type="text" name="${name}" value="${design[name]}" pattern="#[0-9A-Fa-f]{6}" maxlength="7" data-design-field aria-label="${label} hex color"></div></label>`).join('')}</div></fieldset>
        <fieldset class="studio-card"><legend>Type & rhythm</legend><div class="studio-control-grid">
          ${select('headingFont','Heading type',[['Georgia','Georgia serif'],['Optima','Optima'],['Grotesk','Grotesk']])}
          ${select('bodyFont','Body type',[['Grotesk','Grotesk'],['Georgia','Georgia serif'],['Arial','Arial']])}
          <label class="studio-field"><span>Text scale</span><input type="range" name="textScale" min="0.8" max="1.4" step="0.05" value="${design.textScale}" data-design-field><output>${design.textScale}×</output></label>
          <label class="studio-field"><span>Border weight</span><input type="range" name="borderWidth" min="1" max="10" step="1" value="${design.borderWidth}" data-design-field><output>${design.borderWidth}px</output></label>
          ${select('density','Spacing',[['compact','Compact'],['comfortable','Comfortable'],['spacious','Spacious']])}
        </div></fieldset>
        <fieldset class="studio-card studio-card-wide"><legend>Storefront composition</legend><div class="studio-control-grid">
          ${select('heroLayout','Home-page opening',[['gallery','Gallery arrangement'],['split','Split editorial'],['editorial','Editorial minimal']])}
          ${select('productColumns','Products per row',[[2,'Two'],[3,'Three'],[4,'Four'],[5,'Five']])}
          ${select('imageFit','Product photography',[['contain','Show the whole piece'],['cover','Fill the frame']])}
        </div></fieldset>
      </div>
      ${previewMarkup(state.draft)}
    </section>`;
  }

  function contentPanel(state){
    const c=state.draft.content;
    const input=(name,label,value,type='text')=>`<label class="studio-field"><span>${label}</span><input type="${type}" name="${name}" value="${escape(value)}" required></label>`;
    return `<section class="studio-panel content-panel" aria-labelledby="content-title">
      <div class="studio-panel-heading"><p class="eyebrow">Words & contact</p><h2 id="content-title">Sound like the gallery.</h2><p>Edit the most visible welcome and contact details. These changes appear only in Owner Studio preview mode.</p></div>
      <form id="studio-content-form" class="studio-card studio-content-form">
        <fieldset><legend>Home-page welcome</legend>
          ${input('heroTitle','Opening line',c.heroTitle)}
          ${input('heroAccent','Emphasized line',c.heroAccent)}
          <label class="studio-field studio-field-full"><span>Introduction</span><textarea name="heroIntro" rows="4" maxlength="400" required>${escape(c.heroIntro)}</textarea></label>
        </fieldset>
        <fieldset><legend>How people reach the gallery</legend>
          ${input('phone','Phone',c.phone,'tel')}${input('email','Email',c.email,'email')}
          ${input('address','Street address',c.address)}${input('city','City, state & ZIP',c.city)}
        </fieldset>
        <div class="studio-form-actions"><button class="button red" type="submit">Save these words</button><p>Nothing is sent to Shopify or to customers.</p></div>
      </form>
      ${previewMarkup(state.draft)}
    </section>`;
  }

  function effectiveProduct(product,draft){
    const override=draft.products[product.handle]||{};
    return {title:override.title??product.title,priceCents:override.priceCents??Math.round(product.price*100),available:override.available??product.available,dimensionsRaw:override.dimensionsRaw??product.dimensionsRaw??'',imageUrl:override.imageUrl??product.images?.[0]?.src??'',hidden:override.hidden??false};
  }

  function productEditor(product,draft){
    const item=effectiveProduct(product,draft),overridden=Object.hasOwn(draft.products,product.handle);
    return `<details class="studio-product" data-product-handle="${escape(product.handle)}">
      <summary><img src="${escape(item.imageUrl||'assets/brand-original.png')}" alt=""><span><strong>${escape(item.title)}</strong><small>${escape(product.itemNumber||product.sourceProductType||'Gallery item')} · ${money(item.priceCents)}${overridden?' · Edited in Studio':''}</small></span><i class="${item.available?'available':'unavailable'}">${item.hidden?'Hidden':item.available?'Available':'Unavailable'}</i></summary>
      <form data-product-form="${escape(product.handle)}" class="studio-product-form">
        <label class="studio-field studio-field-full"><span>Display title</span><input name="title" value="${escape(item.title)}" maxlength="160" required></label>
        <label class="studio-field"><span>Practice price</span><input name="price" type="number" min="0" max="10000000" step="0.01" value="${(item.priceCents/100).toFixed(2)}" required></label>
        <label class="studio-field"><span>Availability</span><select name="available"><option value="true" ${item.available?'selected':''}>Available</option><option value="false" ${item.available?'':'selected'}>Unavailable</option></select></label>
        <label class="studio-field studio-field-full"><span>Measurements as shown</span><input name="dimensionsRaw" value="${escape(item.dimensionsRaw)}" maxlength="240"></label>
        <label class="studio-field studio-field-full"><span>Practice photo URL</span><input name="imageUrl" type="text" inputmode="url" value="${escape(item.imageUrl)}" placeholder="https://… or assets/photo.jpg"></label>
        <label class="studio-check"><input type="checkbox" name="hidden" ${item.hidden?'checked':''}> Hide this piece from my practice storefront</label>
        <div class="studio-form-actions"><button class="button red" type="submit">Save practice edit</button>${overridden?'<button class="button outline" type="button" data-reset-product>Restore original listing</button>':''}<a class="text-link" href="${context.productHref?context.productHref(product):'#'}">View original details →</a></div>
      </form>
    </details>`;
  }

  function customProductMarkup(product){
    return `<article class="studio-custom-product"><img src="${escape(product.imageUrl||'assets/brand-original.png')}" alt=""><div><strong>${escape(product.title)}</strong><span>${money(product.priceCents)} · ${escape(product.category||'Studio piece')}</span></div><button class="text-link" type="button" data-delete-custom="${escape(product.handle)}">Remove</button></article>`;
  }

  function inventoryPanel(state){
    const query=ui.search.trim().toLowerCase();
    const products=baseProducts().filter(product=>!query||[product.title,product.itemNumber,product.vendor,product.sourceProductType].some(value=>String(value||'').toLowerCase().includes(query)));
    const shown=products.slice(0,Math.max(20,ui.inventoryPage*20));
    return `<section class="studio-panel inventory-panel" aria-labelledby="inventory-title">
      <div class="studio-panel-heading"><p class="eyebrow">Practice inventory</p><h2 id="inventory-title">Try the complete store.</h2><p>Edit how real catalog pieces appear in your browser-local practice preview, or add clearly marked sample pieces. Shopify remains the source of truth outside preview mode.</p></div>
      <div class="studio-inventory-tools"><label><span>Search ${baseProducts().length} real listings</span><input type="search" id="studio-product-search" value="${escape(ui.search)}" placeholder="Title, maker, item number…"></label><strong>${products.length} found</strong></div>
      <div class="studio-product-list">${shown.map(product=>productEditor(product,state.draft)).join('')}${shown.length<products.length?'<button class="button outline studio-load-more" type="button" data-load-products>Show 20 more</button>':''}</div>
      <section class="studio-demo-section"><div class="studio-panel-heading"><p class="eyebrow">Optional sample piece</p><h3>Add something to practice with.</h3><p>Sample pieces exist only in this browser and are labeled as Owner Studio inventory.</p></div>
        <form id="studio-custom-product-form" class="studio-card studio-custom-form">
          <label class="studio-field studio-field-full"><span>Title</span><input name="title" maxlength="160" required></label>
          <label class="studio-field"><span>Practice price</span><input name="price" type="number" min="0" max="10000000" step="0.01" required></label>
          <label class="studio-field"><span>Category</span><input name="category" maxlength="100" placeholder="Chair, artwork, lighting…"></label>
          <label class="studio-field"><span>Measurements</span><input name="dimensionsRaw" maxlength="240" placeholder="W × D × H"></label>
          <label class="studio-field"><span>Availability</span><select name="available"><option value="true">Available</option><option value="false">Unavailable</option></select></label>
          <label class="studio-field studio-field-full"><span>Photo URL</span><input name="imageUrl" type="text" inputmode="url" placeholder="https://… or assets/photo.jpg"></label>
          <label class="studio-field studio-field-full"><span>Or upload a photo</span><input name="imageFile" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPEG, or WebP. Larger phone photos are resized into an embedded browser-local copy under 150 KB; the original file is not changed.</small></label>
          <button class="button red" type="submit">Add sample piece</button>
        </form>
        <div class="studio-custom-list">${state.draft.customProducts.length?state.draft.customProducts.map(customProductMarkup).join(''):'<p>No sample pieces yet.</p>'}</div>
      </section>
    </section>`;
  }

  function versionsPanel(state){
    const status=stateApi().getStatus();
    return `<section class="studio-panel versions-panel" aria-labelledby="versions-title">
      <div class="studio-panel-heading"><p class="eyebrow">Saved versions & recovery</p><h2 id="versions-title">Experiment with impunity.</h2><p>Name the designs worth keeping. Undo small changes, restore a complete version, or keep a JSON backup outside this browser.</p></div>
      <div class="studio-history-tools">
        <button class="button outline" type="button" data-undo ${status.canUndo?'':'disabled'}>Undo last change</button>
        <button class="button outline" type="button" data-redo ${status.canRedo?'':'disabled'}>Redo</button>
        <button class="button outline" type="button" data-export-studio>Export backup</button>
        <label class="button outline studio-import">Import backup<input type="file" data-import-studio accept="application/json,.json"></label>
        <button class="text-link" type="button" data-reset-studio>Reset draft to original</button>
      </div>
      <form id="studio-version-form" class="studio-save-version"><label><span>Name this version</span><input name="name" maxlength="80" placeholder="For example, warmer gallery edit" required></label><button class="button red" type="submit">Save version</button></form>
      <div class="studio-version-list">${state.versions.length?state.versions.slice().reverse().map(version=>`<article><div><strong>${escape(version.name)}</strong><span>Saved ${date(version.createdAt)}</span></div><button class="button outline" type="button" data-restore-version="${escape(version.id)}">Restore</button><button class="text-link" type="button" data-delete-version="${escape(version.id)}">Delete</button></article>`).join(''):`<div class="studio-empty"><h3>No saved versions yet.</h3><p>${status.persisted?'Your current draft is still saved automatically on this browser.':'Browser storage is unavailable, so export a backup before leaving this page if you want to keep the draft.'}</p></div>`}</div>
    </section>`;
  }

  function ordersPanel(state){
    const labels={placed:'Placed',confirmed:'Confirmed',ready_for_pickup:'Ready for pickup',completed:'Completed',cancelled:'Cancelled'};
    return `<section class="studio-panel orders-panel" aria-labelledby="orders-title">
      <div class="studio-panel-heading"><p class="eyebrow">Practice orders</p><h2 id="orders-title">Test the handoff.</h2><p>Practice checkout creates local sample orders here. No payment, reservation, message, customer record, or real order is created.</p></div>
      ${state.orders.length?'<button class="text-link studio-clear-orders" type="button" data-clear-orders>Clear all practice orders</button>':''}
      <div class="studio-order-list">${state.orders.length?state.orders.slice().reverse().map(order=>`<article class="studio-order"><div class="studio-order-top"><div><span class="eyebrow">PRACTICE · ${escape(order.id)}</span><h3>${order.items.length} ${order.items.length===1?'piece':'pieces'} · ${money(order.totalCents)}</h3><p>${date(order.createdAt)}</p></div><label><span>Status</span><select data-order-status="${escape(order.id)}">${Object.entries(labels).map(([value,label])=>`<option value="${value}" ${order.status===value?'selected':''}>${label}</option>`).join('')}</select></label></div><ul>${order.items.map(item=>`<li><span>${escape(item.productTitle)} × ${item.quantity}</span><strong>${money(item.priceCents*item.quantity)}</strong></li>`).join('')}</ul></article>`).join(''):'<div class="studio-empty"><h3>No practice orders yet.</h3><p>Preview your storefront, add a piece to the practice bag, and complete the practice checkout.</p><button class="button red" type="button" data-preview-store>Preview & place a practice order →</button></div>'}</div>
    </section>`;
  }

  function activityPanel(state){
    const statusLabels={new:'New practice item',reviewed:'Reviewed in practice',replied:'Reply practiced'};
    const kindLabels={newsletter:'Newsletter signup',consignment:'Consignment inquiry'};
    return `<section class="studio-panel activity-panel" aria-labelledby="activity-title">
      <div class="studio-panel-heading"><p class="eyebrow">Practice activity</p><h2 id="activity-title">Rehearse the follow-through.</h2><p>Sample newsletter signups and consignment inquiries created in preview mode appear here. They stay in this browser; no message, subscription, customer record, or reply is sent.</p></div>
      ${state.messages.length?'<button class="text-link studio-clear-messages" type="button" data-clear-messages>Clear all practice activity</button>':''}
      <div class="studio-message-list">${state.messages.length?state.messages.slice().reverse().map(message=>`<article class="studio-activity-card"><div class="studio-activity-top"><div><span class="eyebrow">PRACTICE · ${escape(kindLabels[message.kind]||message.kind)}</span><h3>${escape(message.title)}</h3><p>${date(message.createdAt)}</p></div><label><span>Follow-up status</span><select data-message-status="${escape(message.id)}">${Object.entries(statusLabels).map(([value,label])=>`<option value="${value}" ${message.status===value?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="studio-activity-body">${escape(message.body).replaceAll('\n','<br>')}</div><small>No real communication was sent.</small></article>`).join(''):'<div class="studio-empty"><h3>No practice activity yet.</h3><p>Preview the storefront, try a newsletter signup or prepare a consignment inquiry, then return here to practice the owner workflow.</p><button class="button red" type="button" data-preview-store>Preview the activity flow →</button></div>'}</div>
    </section>`;
  }

  function panelMarkup(state){
    return ({design:designPanel,content:contentPanel,inventory:inventoryPanel,versions:versionsPanel,orders:ordersPanel,activity:activityPanel}[ui.tab]||designPanel)(state);
  }

  function confirmMarkup(){
    return `<dialog id="studio-confirm-dialog" class="studio-confirm-dialog" aria-labelledby="studio-confirm-title" aria-describedby="studio-confirm-copy"><div class="studio-confirm-card"><p class="eyebrow">Please confirm</p><h2 id="studio-confirm-title">Confirm this change</h2><p id="studio-confirm-copy"></p><div class="studio-confirm-actions"><button class="button outline" type="button" data-confirm-cancel>Cancel</button><button class="button red" type="button" data-confirm-accept>Continue</button></div></div></dialog>`;
  }

  function renderApp(){
    const host=root.document?.querySelector('#studio-app'),api=stateApi();
    if(!host||!api)return false;
    if(pendingConfirm)closeConfirm();
    if(!signedIn()){host.innerHTML=loginMarkup(ui.loginMessage);return true;}
    const state=api.read();
    host.innerHTML=`${headerMarkup(state)}${navMarkup(state)}<div class="studio-message ${ui.messageKind}" role="status" ${ui.message?'':'hidden'}>${escape(ui.message)}</div>${panelMarkup(state)}${confirmMarkup()}`;
    return true;
  }

  function show(message,kind='status'){ui.message=message;ui.messageKind=kind;renderApp();}
  function action(work,success){
    try{
      if(!signedIn())throw new Error('Sign in to Owner Studio to make changes.');
      if(stateApi().getStatus().conflict)throw new Error('Another tab has newer Studio changes. Reload this page before editing.');
      work();const persisted=stateApi().getStatus().persisted;ui.message=persisted?(success||''):'Change kept for this visit only. Browser storage could not save it. Export a backup before closing or reloading.';ui.messageKind=persisted?'status':'error';renderApp();
    }
    catch(error){show(error?.message||'That change could not be saved.','error');}
  }

  function activateAndNavigate(active){
    try{
      if(stateApi().getStatus().conflict)throw new Error('Another tab has newer Studio changes. Reload this page before changing preview mode.');
      stateApi().setActive(active);
      if(!stateApi().getStatus().persisted)throw new Error('Browser storage is unavailable, so a cross-page preview cannot open reliably. Keep this page open and export a backup, then enable browser storage before trying again.');
      root.location.href='index.html';
    }
    catch(error){show(error?.message||'Preview mode could not be changed.','error');}
  }

  function restoreDialogFocus(pending){
    root.setTimeout(()=>{
      const target=pending?.returnFocus?.isConnected?pending.returnFocus:pending?.restoreSelector?root.document.querySelector(pending.restoreSelector):null;
      target?.focus?.();
    },0);
  }

  function closeConfirm({restore=true}={}){
    const dialog=root.document?.querySelector('#studio-confirm-dialog'),pending=pendingConfirm;
    pendingConfirm=null;
    root.document?.documentElement.classList.remove('studio-dialog-open');
    if(dialog){
      try{if(dialog.open&&typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}catch{dialog.removeAttribute('open');}
      dialog.classList.remove('studio-confirm-fallback');
    }
    if(restore)restoreDialogFocus(pending);
  }

  function openConfirm({title,copy,actionLabel,work,trigger,restoreSelector,onCancel}){
    const dialog=root.document?.querySelector('#studio-confirm-dialog');
    if(!dialog)return false;
    if(pendingConfirm)closeConfirm({restore:false});
    pendingConfirm={work,returnFocus:trigger||root.document.activeElement,restoreSelector,onCancel};
    dialog.querySelector('#studio-confirm-title').textContent=title;
    dialog.querySelector('#studio-confirm-copy').textContent=copy;
    dialog.querySelector('[data-confirm-accept]').textContent=actionLabel;
    dialog.oncancel=event=>{event.preventDefault();const pending=pendingConfirm;closeConfirm();pending?.onCancel?.();};
    root.document.documentElement.classList.add('studio-dialog-open');
    try{
      if(typeof dialog.showModal==='function')dialog.showModal();
      else{dialog.setAttribute('open','');dialog.classList.add('studio-confirm-fallback');}
    }catch{dialog.setAttribute('open','');dialog.classList.add('studio-confirm-fallback');}
    root.setTimeout(()=>dialog.querySelector('[data-confirm-cancel]')?.focus(),0);
    return true;
  }

  async function acceptConfirm(){
    const pending=pendingConfirm;
    if(!pending)return;
    closeConfirm({restore:false});
    try{await pending.work();}
    catch(error){show(error?.message||'That change could not be completed.','error');}
    restoreDialogFocus(pending);
  }

  function designValue(target){
    if(target.name==='textScale')return Number(target.value);
    if(target.name==='borderWidth'||target.name==='productColumns')return Number(target.value);
    return target.value;
  }

  function readImage(file){
    if(!file)return Promise.resolve({dataUrl:'',resized:false});
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))return Promise.reject(new Error('Choose a PNG, JPEG, or WebP image. SVG files are not accepted.'));
    if(file.size>30*1024*1024)return Promise.reject(new Error('This photo is too large to prepare safely. Choose an image under 30 MB.'));
    const readDataUrl=blob=>new Promise((resolve,reject)=>{
      const reader=new root.FileReader();
      reader.onerror=()=>reject(new Error('The image could not be read.'));
      reader.onload=()=>resolve(String(reader.result||''));
      reader.readAsDataURL(blob);
    });
    const canvasBlob=(canvas,quality)=>new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
    const decode=async()=>{
      if(typeof root.createImageBitmap==='function')return {source:await root.createImageBitmap(file),revoke(){this.source.close?.();}};
      const url=root.URL.createObjectURL(file),image=new root.Image();
      try{
        await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('The selected file is not a readable photograph.'));image.src=url;});
        return {source:image,revoke(){root.URL.revokeObjectURL(url);}};
      }catch(error){root.URL.revokeObjectURL(url);throw error;}
    };
    return (async()=>{
      let decoded;
      try{
        decoded=await decode();
        const source=decoded.source,sourceWidth=source.width||source.naturalWidth,sourceHeight=source.height||source.naturalHeight;
        if(!sourceWidth||!sourceHeight)throw new Error('The selected file has no readable image dimensions.');
        if(file.size<=stateApi().MAX_IMAGE_BYTES)return {dataUrl:await readDataUrl(file),resized:false,bytes:file.size};
        for(const longestSide of [1600,1280,1024,800,640,480]){
          const scale=Math.min(1,longestSide/Math.max(sourceWidth,sourceHeight)),width=Math.max(1,Math.round(sourceWidth*scale)),height=Math.max(1,Math.round(sourceHeight*scale));
          const canvas=root.document.createElement('canvas');canvas.width=width;canvas.height=height;
          const drawing=canvas.getContext('2d',{alpha:false});
          if(!drawing)throw new Error('This browser could not prepare the photo.');
          drawing.fillStyle='#fff9ed';drawing.fillRect(0,0,width,height);drawing.drawImage(source,0,0,width,height);
          for(const quality of [.88,.8,.72,.64,.56,.48,.4]){
            const blob=await canvasBlob(canvas,quality);
            if(blob&&blob.size<=stateApi().MAX_IMAGE_BYTES)return {dataUrl:await readDataUrl(blob),resized:true,bytes:blob.size};
          }
        }
        throw new Error('The photo could not be reduced below 150 KB. Choose a simpler or smaller image.');
      }catch(error){
        if(error?.message)throw error;
        throw new Error('The selected file is not a readable photograph.');
      }finally{decoded?.revoke();}
    })();
  }

  function slug(value){return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'piece';}
  function downloadBackup(){
    const blob=new root.Blob([stateApi().exportBackup()],{type:'application/json'}),url=root.URL.createObjectURL(blob),link=root.document.createElement('a');
    link.href=url;link.download=`kiss-it-goodbuy-owner-studio-${new Date().toISOString().slice(0,10)}.json`;link.click();root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);
  }

  async function submitCustom(form){
    const data=new root.FormData(form),file=data.get('imageFile'),prepared=root.File&&file instanceof root.File&&file.size?await readImage(file):{dataUrl:'',resized:false};
    if(!signedIn())throw new Error('Sign in again before adding a sample piece.');
    const title=String(data.get('title')||'').trim(),existing=current().draft.customProducts;
    let now=Date.now();while(existing.some(product=>product.id===String(now)))now++;
    const item={
      id:String(now),handle:`studio-${slug(title)}-${String(now).slice(-6)}`,title,
      priceCents:Math.round(Number(data.get('price'))*100),available:data.get('available')==='true',
      dimensionsRaw:String(data.get('dimensionsRaw')||'').trim(),imageUrl:prepared.dataUrl||String(data.get('imageUrl')||'').trim(),
      category:String(data.get('category')||'').trim()
    };
    const customProducts=[...existing,item];
    stateApi().updateDraft({customProducts});
    ui.message=prepared.resized?'Sample piece added. A resized browser-local copy of the photo was embedded; the original file was not changed.':'Sample piece added to the practice inventory.';ui.messageKind='status';
  }

  function bind(host){
    host.addEventListener('click',async event=>{
      if(event.target.closest('[data-studio-signout]')){
        setSignedIn(false);root.clearTimeout(ui.searchTimer);ui.message='';ui.loginMessage=sessionInMemory?'Signed out on this page. Session storage could not be cleared; close this tab to finish signing out.':'';
        try{stateApi().setActive(false);}catch{}
        renderApp();root.document.querySelector('#studio-username')?.focus();return;
      }
      if(!signedIn())return;
      const cancel=event.target.closest('[data-confirm-cancel]');
      if(cancel){const pending=pendingConfirm;closeConfirm();pending?.onCancel?.();return;}
      if(event.target.closest('[data-confirm-accept]')){await acceptConfirm();return;}
      if(pendingConfirm&&!event.target.closest('#studio-confirm-dialog')){event.preventDefault();return;}
      const tab=event.target.closest('[data-studio-tab]');if(tab){setTab(tab.dataset.studioTab);return;}
      const preset=event.target.closest('[data-preset]');if(preset){action(()=>stateApi().updateDraft({design:PRESETS[preset.dataset.preset].design}),PRESETS[preset.dataset.preset].label+' applied.');return;}
      if(event.target.closest('[data-preview-store]')){activateAndNavigate(true);return;}
      if(event.target.closest('[data-return-original]')){activateAndNavigate(false);return;}
      if(event.target.closest('[data-undo]')){action(()=>stateApi().undo(),'Last Studio change undone.');return;}
      if(event.target.closest('[data-redo]')){action(()=>stateApi().redo(),'Change restored.');return;}
      if(event.target.closest('[data-export-studio]')){try{downloadBackup();show('Backup downloaded.');}catch(error){show(error.message,'error');}return;}
      const resetStudio=event.target.closest('[data-reset-studio]');
      if(resetStudio){openConfirm({title:'Reset the current draft?',copy:'This restores the original design, welcome and contact content, inventory edits, and sample pieces. Saved versions, practice orders, and practice activity remain. You can also undo the reset while it remains in recent history.',actionLabel:'Reset current draft',trigger:resetStudio,restoreSelector:'[data-reset-studio]',work:()=>action(()=>stateApi().resetDraft(),'Draft reset. You can still undo or restore a saved version.')});return;}
      const restore=event.target.closest('[data-restore-version]');if(restore){action(()=>stateApi().restoreVersion(restore.dataset.restoreVersion),'Saved version restored.');return;}
      const removeVersion=event.target.closest('[data-delete-version]');
      if(removeVersion){const version=current().versions.find(item=>item.id===removeVersion.dataset.deleteVersion);openConfirm({title:'Delete this saved version?',copy:`${version?.name||'This version'} will be removed from this browser. Deleting a named version cannot be undone. Your current draft is not changed.`,actionLabel:'Delete saved version',trigger:removeVersion,restoreSelector:'[data-studio-tab="versions"]',work:()=>action(()=>stateApi().deleteVersion(removeVersion.dataset.deleteVersion),'Saved version deleted.')});return;}
      const resetProduct=event.target.closest('[data-reset-product]');if(resetProduct){const handle=resetProduct.closest('[data-product-handle]').dataset.productHandle;action(()=>stateApi().updateDraft({products:{[handle]:null}}),'Original listing restored in the practice preview.');return;}
      const removeCustom=event.target.closest('[data-delete-custom]');if(removeCustom){const customProducts=current().draft.customProducts.filter(item=>item.handle!==removeCustom.dataset.deleteCustom);action(()=>stateApi().updateDraft({customProducts}),'Sample piece removed.');return;}
      if(event.target.closest('[data-load-products]')){ui.inventoryPage++;renderApp();return;}
      const clearOrders=event.target.closest('[data-clear-orders]');
      if(clearOrders){openConfirm({title:'Clear all practice orders?',copy:'Every browser-local practice order will be removed. This does not affect Shopify or any real order, and it cannot be undone.',actionLabel:'Clear practice orders',trigger:clearOrders,restoreSelector:'[data-studio-tab="orders"]',work:()=>action(()=>stateApi().clearOrders(),'Practice orders cleared.')});return;}
      const clearMessages=event.target.closest('[data-clear-messages]');
      if(clearMessages){openConfirm({title:'Clear all practice activity?',copy:'Every browser-local sample newsletter signup and consignment inquiry will be removed. No real communication is affected, and this cannot be undone.',actionLabel:'Clear practice activity',trigger:clearMessages,restoreSelector:'[data-studio-tab="activity"]',work:()=>action(()=>stateApi().clearMessages(),'Practice activity cleared.')});}
    });
    host.addEventListener('input',event=>{
      if(!signedIn())return;
      if(event.target.id==='studio-product-search'){
        ui.search=event.target.value;ui.inventoryPage=1;root.clearTimeout(ui.searchTimer);
        const cursor=event.target.selectionStart;
        ui.searchTimer=root.setTimeout(()=>{renderApp();const search=root.document.querySelector('#studio-product-search');search?.focus();search?.setSelectionRange?.(cursor,cursor);},180);
        return;
      }
      const picker=event.target.closest('[data-color-picker]');if(picker){const text=host.querySelector(`[name="${picker.dataset.colorPicker}"][data-design-field]`);if(text)text.value=picker.value;}
      if(event.target.matches('[data-design-field][type=range]')){const output=event.target.parentElement.querySelector('output');if(output)output.value=event.target.name==='borderWidth'?event.target.value+'px':event.target.value+'×';}
    });
    host.addEventListener('keydown',event=>{
      const dialog=root.document.querySelector('#studio-confirm-dialog');
      if(!pendingConfirm||!dialog?.classList.contains('studio-confirm-fallback'))return;
      if(event.key==='Escape'){
        event.preventDefault();const pending=pendingConfirm;closeConfirm();pending?.onCancel?.();return;
      }
      if(event.key!=='Tab')return;
      const controls=[...dialog.querySelectorAll('button:not([disabled])')];
      if(!controls.length)return;
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&root.document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&root.document.activeElement===last){event.preventDefault();first.focus();}
    });
    host.addEventListener('change',async event=>{
      if(event.target.matches('[data-show-studio-password]')){const password=host.querySelector('#studio-password');if(password)password.type=event.target.checked?'text':'password';return;}
      if(!signedIn())return;
      const design=event.target.closest('[data-design-field]');
      if(design){action(()=>stateApi().updateDraft({design:{[design.name]:designValue(design)}}),'Design change saved.');return;}
      const picker=event.target.closest('[data-color-picker]');
      if(picker){action(()=>stateApi().updateDraft({design:{[picker.dataset.colorPicker]:picker.value}}),'Color saved.');return;}
      const order=event.target.closest('[data-order-status]');
      if(order){action(()=>stateApi().updateOrderStatus(order.dataset.orderStatus,order.value),'Practice order updated.');return;}
      const message=event.target.closest('[data-message-status]');
      if(message){action(()=>stateApi().updateMessageStatus(message.dataset.messageStatus,message.value),'Practice follow-up updated.');return;}
      const input=event.target.closest('[data-import-studio]');
      if(input&&input.files?.[0]){
        try{
          const file=input.files[0];if(file.size>stateApi().MAX_STATE_BYTES)throw new Error('The backup is larger than 4 MB.');
          const json=await file.text();
          openConfirm({title:'Replace this Studio workspace?',copy:'Importing this backup replaces the current draft, named versions, practice orders, practice activity, and preview-mode setting. It does not merge workspaces. Export the current workspace first if you need to keep it.',actionLabel:'Import and replace',trigger:input,restoreSelector:'[data-import-studio]',onCancel:()=>{input.value='';},work:()=>action(()=>stateApi().importBackup(json),'Backup imported and checked.')});
        }catch(error){input.value='';show(error.message,'error');}
      }
    });
    host.addEventListener('submit',async event=>{
      event.preventDefault();const form=event.target;
      if(form.id==='studio-login-form'){
        const fields=new root.FormData(form);
        if(String(fields.get('username')||'').trim()==='Chelsea'&&fields.get('password')==='Chelsea'){
          setSignedIn(true);ui.loginMessage='';renderApp();const main=root.document.querySelector('#main');if(main){main.tabIndex=-1;main.focus({preventScroll:true});}
        }else{
          const error=host.querySelector('#studio-login-error');error.hidden=false;error.textContent='That login or password does not match. Both are case-sensitive.';
          const password=host.querySelector('#studio-password');password.value='';password.focus();
        }
        return;
      }
      if(!signedIn()){renderApp();return;}
      if(form.id==='studio-content-form'){const data=Object.fromEntries(new root.FormData(form).entries());action(()=>stateApi().updateDraft({content:data}),'Words and contact details saved.');return;}
      if(form.id==='studio-version-form'){const name=String(new root.FormData(form).get('name')||'').trim();action(()=>stateApi().saveVersion(name),'Version saved.');return;}
      if(form.matches('[data-product-form]')){
        const handle=form.dataset.productForm,product=baseProducts().find(item=>item.handle===handle);if(!product)return;
        const data=new root.FormData(form),basePrice=Math.round(product.price*100),priceCents=Math.round(Number(data.get('price'))*100);
        const patch={title:String(data.get('title')).trim()===product.title?null:String(data.get('title')).trim(),priceCents:priceCents===basePrice?null:priceCents,available:(data.get('available')==='true')===product.available?null:data.get('available')==='true',dimensionsRaw:String(data.get('dimensionsRaw')||'')===(product.dimensionsRaw||'')?null:String(data.get('dimensionsRaw')||''),imageUrl:String(data.get('imageUrl')||'')===(product.images?.[0]?.src||'')?null:String(data.get('imageUrl')||''),hidden:data.get('hidden')==='on'?true:null};
        action(()=>stateApi().updateDraft({products:{[handle]:patch}}),'Practice listing saved.');return;
      }
      if(form.id==='studio-custom-product-form'){try{await submitCustom(form);renderApp();}catch(error){show(error.message,'error');}}
    });
  }

  function mount(nextContext){
    if(nextContext)context=nextContext;
    const host=root.document?.querySelector('#studio-app');
    if(!host||!context||!stateApi())return false;
    ui.tab=tabFromUrl();
    if(!mounted){mounted=true;bind(host);unsubscribe=stateApi().subscribe(()=>renderApp());root.addEventListener?.('pageshow',()=>renderApp());root.addEventListener?.('pagehide',()=>{volatileSignIn=false;});}
    renderApp();
    return true;
  }

  return {render,mount,PRESETS};
});
