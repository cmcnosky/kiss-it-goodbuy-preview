(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;root.KIGBStudioRuntime=api;})(typeof globalThis!=='undefined'?globalThis:window,function(root){
  'use strict';
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
  function customId(handle){let hash=2166136261;for(const char of handle)hash=Math.imul(hash^char.charCodeAt(0),16777619);return String(800000000000000+(hash>>>0));}
  function makeProduct(item){
    const id=customId(item.handle),price=item.priceCents/100,available=item.available!==false;
    return {id,handle:item.handle,title:item.title,productUrl:'product.html?piece='+encodeURIComponent(item.handle),description:'A practice inventory item created in the Owner Studio.',sourceHtml:'<p>A practice inventory item created in the Owner Studio.</p>',sourceProductType:item.category||'Studio piece',vendor:'Owner Studio',tags:['Practice item'],itemNumber:'STUDIO-'+id.slice(-6),itemId:id,sourceCategory:item.category||'Studio piece',dimensionsRaw:item.dimensionsRaw||'',dimensions:root.KIGBCatalog?.extractDimensions(item.dimensionsRaw||'')||null,createdAt:'2026-11-06T00:00:00Z',updatedAt:null,publishedAt:'2026-11-06T00:00:00Z',available,price,minPrice:price,maxPrice:price,compareAtPrice:null,variants:[{id:String(Number(id)+10000000000),title:'Default Title',price,priceCents:item.priceCents,compareAtPrice:null,compareAtPriceCents:null,available,sku:'STUDIO-'+id.slice(-6),position:1}],images:item.imageUrl?[{src:item.imageUrl,alt:item.title,width:null,height:null,position:1}]:[],options:[{name:'Title',values:['Default Title']}],collections:['new-items'],_studioEditedTitle:true,_studioCustom:true};
  }
  function applyInventory(base,draft={}){
    const overrides=draft.products||{};
    const products=(base.products||[]).filter(p=>!overrides[p.handle]?.hidden).map(original=>{
      const patch=overrides[original.handle];if(!patch)return original;
      const p={...original,variants:original.variants.map(v=>({...v})),images:original.images.map(im=>({...im}))};
      if(own(patch,'title')){p.title=patch.title;p._studioEditedTitle=true;}
      if(own(patch,'available')){p.available=patch.available;p.variants.forEach(v=>v.available=patch.available);}
      if(own(patch,'priceCents')&&!/gift.?card/i.test(p.sourceProductType+' '+p.title)){
        const value=patch.priceCents/100;p.price=p.minPrice=p.maxPrice=value;p.compareAtPrice=null;
        p.variants.forEach(v=>Object.assign(v,{price:value,priceCents:patch.priceCents,compareAtPrice:null,compareAtPriceCents:null}));
      }
      if(own(patch,'dimensionsRaw')){p.dimensionsRaw=patch.dimensionsRaw;p.dimensions=root.KIGBCatalog?.extractDimensions(patch.dimensionsRaw)||null;}
      if(own(patch,'imageUrl'))p.images=patch.imageUrl?[{src:patch.imageUrl,alt:p.title,width:null,height:null,position:1},...p.images.filter(im=>im.src!==patch.imageUrl)]:[];
      return p;
    });
    for(const item of draft.customProducts||[])if(!item.hidden&&!products.some(p=>p.handle===item.handle))products.push(makeProduct(item));
    const ids=new Set(products.map(p=>p.id));
    const collections=(base.collections||[]).map(c=>({...c,productIds:c.handle==='new-items'?products.map(p=>p.id):c.productIds.filter(id=>ids.has(String(id)))}));
    return {...base,products,collections};
  }
  function toolbar(active){return `<aside class="owner-preview-bar" aria-label="Owner preview controls"><div><strong>${active?'Your practice storefront':'Explore the Owner Studio'}</strong><span>${active?'Your saved design and sample inventory. Practice orders stay on this browser.':'Try design changes, edit sample inventory, and save versions.'}</span></div><a href="studio.html">${active?'Edit in Owner Studio':'Open Owner Studio'} →</a>${active?'<button type="button" data-exit-studio>Return to original</button>':''}</aside>`;}
  function applyTheme(draft){
    if(!root.document)return;
    const element=root.document.documentElement,d=draft.design||{};
    element.classList.add('studio-preview');
    const variables={coral:'--coral',celadon:'--celadon',ochre:'--ochre',cream:'--cream',ink:'--ink',frame:'--frame'};
    for(const [key,css] of Object.entries(variables))if(/^#[a-f\d]{6}$/i.test(d[key]||''))element.style.setProperty(css,d[key]);
    if(d.cream)element.style.setProperty('--paper',d.cream);
    if(d.frame)element.style.setProperty('--red',d.frame);
    element.style.setProperty('--border-width',(d.borderWidth||5)+'px');
    element.style.setProperty('--studio-text-scale',String(d.textScale||1));
    element.style.setProperty('--studio-columns',String(d.productColumns||3));
    element.style.setProperty('--studio-heading-font',({'Georgia':'Georgia, serif','Optima':'Optima, Candara, Arial, sans-serif','Grotesk':'Grotesk, Arial, sans-serif'}[d.headingFont]||'Georgia, serif'));
    element.style.setProperty('--studio-body-font',d.bodyFont==='Arial'?'Arial, sans-serif':d.bodyFont==='Georgia'?'Georgia, serif':'Grotesk, Arial, sans-serif');
    element.dataset.studioHero=d.heroLayout||'gallery';element.dataset.studioDensity=d.density||'comfortable';element.dataset.studioImage=d.imageFit||'contain';
    const content=draft.content||{};
    for(const link of root.document.querySelectorAll('a[href^="tel:"]')){if(content.phone){const digits=content.phone.replace(/\D/g,'');link.href='tel:+'+(digits.length===10?'1':'')+digits;if(link.textContent.includes('817-481-9754'))link.textContent=link.textContent.replace('817-481-9754',content.phone);}}
    for(const link of root.document.querySelectorAll('a[href^="mailto:"]')){if(content.email){link.href=link.getAttribute('href').replace('info@kissitgoodbuy.net',encodeURIComponent(content.email));if(link.textContent==='info@kissitgoodbuy.net')link.textContent=content.email;}}
    const walker=root.document.createTreeWalker(root.document.getElementById('app'),root.NodeFilter.SHOW_TEXT);
    const pairs=[['201 East Franklin Street',content.address],['201 E. Franklin Street',content.address],['Grapevine, TX 76051',content.city],['Grapevine, Texas 76051',content.city]];
    while(walker.nextNode()){const node=walker.currentNode;if(node.parentElement.closest('.owner-preview-bar'))continue;for(const [old,value] of pairs)if(value&&node.nodeValue.includes(old))node.nodeValue=node.nodeValue.replaceAll(old,value);}
  }
  function checkoutPage(lines,active){
    if(!active)return '<main id="main" class="practice-checkout"><h1>Practice checkout</h1><p>Open the Owner Studio and preview your draft to try a complete practice order.</p><a class="button red" href="studio.html">Open Owner Studio →</a></main>';
    if(!lines.length)return '<main id="main" class="practice-checkout"><p class="eyebrow">Owner Studio · Practice only</p><h1>Choose a practice piece.</h1><p>Your practice bag is empty. Add any piece while previewing your draft.</p><a class="button red" href="collection.html">Explore the practice inventory →</a></main>';
    if(lines.length>50||lines.some(l=>l.available===false||!Number.isSafeInteger(l.priceCents)||l.priceCents<0||!Number.isInteger(l.quantity)||l.quantity<1||l.quantity>250))return '<main id="main" class="practice-checkout"><h1>Review your practice bag.</h1><p>A piece changed, is unavailable, or needs a valid price or quantity. Keep practice orders to 50 different pieces.</p><a class="button red" href="cart.html">Return to the practice bag →</a></main>';
    const total=lines.reduce((sum,l)=>sum+l.priceCents*l.quantity,0);
    return `<main id="main" class="practice-checkout"><div class="breadcrumb"><a href="cart.html">Practice bag</a> / Checkout</div><p class="eyebrow">Owner Studio · Practice only</p><h1>Try the complete purchase flow.</h1><p class="practice-intro">This creates a sample order in your Owner Studio. No payment is taken, no message is sent, and no real item is reserved.</p><div class="practice-layout"><section><h2>Your practice order</h2>${lines.map(l=>`<article class="practice-order-line"><span>${escape(l.productTitle)}<small>Quantity ${l.quantity}</small></span><strong>${money(l.priceCents*l.quantity)}</strong></article>`).join('')}<p class="practice-subtotal"><span>Sample subtotal</span><strong>${money(total)}</strong></p><p class="form-note">Tax and payment processing are not connected in practice mode.</p></section><form id="practice-order-form"><h2>Pickup & confirmation</h2><label for="practice-pickup">Pickup option</label><select id="practice-pickup" required><option>Gallery pickup — practice only</option></select><div class="practice-payment"><strong>Practice payment</strong><p>Approved for this demonstration. No card details are needed or accepted.</p></div><label class="practice-confirm"><input type="checkbox" id="practice-acknowledge" required> I understand this is a sample order.</label><button class="button red" type="submit">Place practice order →</button><p id="practice-order-message" role="status" tabindex="-1"></p></form></div></main>`;
  }
  function mountPractice({getLines,clearBag,render,toast}){
    root.document?.querySelector('#practice-order-form')?.addEventListener('submit',event=>{
      event.preventDefault();const button=event.target.querySelector('button[type="submit"]');if(button.disabled)return;
      button.disabled=true;
      try{const order=root.KIGBStudioState.createOrder(getLines().map(l=>({variantId:l.variantId,productHandle:l.productHandle,productTitle:l.productTitle.slice(0,160),quantity:l.quantity,priceCents:l.priceCents,currencyCode:l.currencyCode||'USD',imageUrl:l.imageUrl||''})));clearBag();const orderId=order?.id||order?.order?.id,persisted=root.KIGBStudioState.getStatus().persisted;render(`<section class="practice-complete"><p class="eyebrow">Practice order recorded</p><h1>That’s the complete dry run.</h1><p>Your sample order ${orderId?`<strong>${escape(orderId)}</strong>`:''} is ready in the Owner Studio. You can change its status there and repeat the exercise.</p><p>No payment, reservation, customer message, or real order was created.</p>${persisted?'':'<p role="status">Browser storage is unavailable. This sample order is kept for this visit only; export a backup from the Studio before leaving.</p>'}<a class="button red" href="studio.html?tab=orders">View practice orders →</a><a class="text-link" href="collection.html">Keep exploring the practice store</a></section>`);}
      catch(error){button.disabled=false;const message=root.document.querySelector('#practice-order-message');message.textContent=error.message||'The practice order could not be saved. Your bag is still here.';message.focus();}
    });
  }
  return Object.freeze({applyInventory,makeProduct,toolbar,applyTheme,checkoutPage,mountPractice,customId});
});
