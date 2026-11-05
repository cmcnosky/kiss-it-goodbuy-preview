import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),dist=path.join(root,'dist');
const inventory=JSON.parse(fs.readFileSync(path.join(dist,'inventory.json'),'utf8'));
const app=fs.readFileSync(path.join(dist,'app.js'),'utf8').split('// BROWSER START')[0];
const context={location:new URL('https://example.test/collection.html'),URL,URLSearchParams,Intl,Date,KIGB_INVENTORY:inventory,localStorage:{getItem:()=>null}};context.window=context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(dist,'catalog.js'),'utf8')+'\n'+fs.readFileSync(path.join(dist,'commerce.js'),'utf8')+'\n'+app,context);
const run=code=>vm.runInContext(code,context);
assert.equal(run('PRODUCTS.length'),inventory.products.length);
assert.equal(run("filterProducts(PRODUCTS,filterState(new URLSearchParams('collection=seating'))).length"),inventory.collections.find(c=>c.handle==='seating').productIds.length);
assert.equal(run("filterProducts(PRODUCTS,filterState(new URLSearchParams('q=gift%20card&min=100&budget=250'))).length"),1,'variant range must match gift denomination');
assert.equal(run("filterProducts(PRODUCTS,filterState(new URLSearchParams('q=8468-7')))[0].itemNumber"),'8468-7');
assert.equal(run("filterProducts(PRODUCTS,filterState(new URLSearchParams('availability=sold'))).length"),inventory.products.filter(p=>!p.available).length);
assert.equal(run("filterProducts(PRODUCTS,filterState(new URLSearchParams('min=1000&budget=10'))).length"),0);
assert.equal(run("filterState(new URLSearchParams('page=-9')).page"),1);
assert.equal(run("filterState(new URLSearchParams('budget=bad')).budget"),null);
assert.ok(run("filterUrl(filterState(),{q:'oak & teak',page:2})").includes('oak+%26+teak'));
assert.equal((run('catalogResults(filterState())').match(/<article class="product">/g)||[]).length,24);
assert.equal((run("catalogResults(filterState(new URLSearchParams('page=999')))" ).match(/<article class="product">/g)||[]).length,inventory.products.length%24||24);
run("remoteOrder={productIds:PRODUCTS.slice(0,2).map(p=>'gid://shopify/Product/'+p.id)}");
assert.equal(run("filterProducts(PRODUCTS,{...filterState(),sort:'relevance'}).length"),2,'Shopify GIDs must match normalized numeric IDs');
assert.equal(run("numericProductId('gid://shopify/Product/123')"),'123');
assert.equal(run("productHref({handle:'a-newly-published-piece'})"),'product.html?piece=a-newly-published-piece','new products must not require a static rebuild');
assert.ok(run('productHref(PRODUCTS[0])').startsWith('products/'));
assert.ok(run("productCard(PRODUCTS.find(p=>isGiftCard(p)))").includes('denominations'));
assert.ok(!run("productCard(PRODUCTS.find(p=>isGiftCard(p)))").includes('Measurements'));
const parsed=run('pageHtml()');assert.ok(!parsed.includes('undefined'));assert.ok(!parsed.includes('NaN'));
console.log('Storefront integration checks passed: catalog/variants, GID matching, pagination, new-product routes, gift-card presentation, URL state.');

// Merchandising must remain truthful as one-off pieces sell or disappear.
const initialProducts=run('PRODUCTS');
run("PRODUCTS=PRODUCTS.filter(p=>!edits.some(e=>e.handle===p.handle));");
const fallback=run("displaySelection(['leopard-loveseat.jpg','peacock-chair.jpg','dragonfly-lamp.jpg'],3)");
assert.equal(new Set(fallback.map(p=>p.id)).size,3,'replacement hero slots must be distinct');
assert.ok(fallback.every(p=>p.available&&p.images.length&&!/gift.?card/i.test(p.title)),'replacement hero items must have a current photograph and availability');
run('PRODUCTS=[]');
assert.doesNotThrow(()=>run('home()'),'an empty catalog must not crash the homepage');
context.testProducts=initialProducts;run('PRODUCTS=testProducts');
const fixtureSource=inventory.products.find(p=>p.available&&p.variants.some(v=>v.available));
assert.ok(fixtureSource,'a purchasable source product is required for the synthetic no-photo fixture');
context.noPhotoFixture={
  ...fixtureSource,
  id:'99999999999999',
  handle:'synthetic-no-photo-regression',
  title:'Synthetic no-photo regression piece',
  images:[]
};
const missingMarkup=run('productCard(presentProducts([noPhotoFixture])[0])');
assert.ok(missingMarkup.includes('Photograph not supplied'));
assert.ok(missingMarkup.includes('src="assets/brand-original.png" alt=""'),'fallback brand artwork must not be described as a product photograph');
const missingCartMarkup=run(`(()=>{const p=presentProducts([noPhotoFixture])[0],v=p.variants.find(v=>v.available)||p.variants[0];PRODUCTS=[p];cartLines=[{variantId:'gid://shopify/ProductVariant/'+v.id,quantity:1,productHandle:p.handle,productTitle:p.title,variantTitle:v.title,priceCents:v.priceCents,compareAtPriceCents:v.compareAtPriceCents,currencyCode:'USD',imageUrl:p.image,onlineStoreUrl:p.productUrl,available:true}];return cartContent();})()`);
assert.ok(missingCartMarkup.includes('cart-photo-missing'),'the bag must use an explicit no-photo treatment');
assert.ok(!missingCartMarkup.includes('<img src="assets/brand-original.png"'),'the bag must not present brand artwork as a product photograph');
context.testProducts=initialProducts;run('PRODUCTS=testProducts;cartLines=[]');
const newest=run('latestFinds([])');
assert.equal(new Set(newest.map(p=>p.id)).size,newest.length);
assert.ok(newest.every(p=>p.available&&p.images.length));
assert.ok(newest.every((p,i)=>!i||Date.parse(newest[i-1].publishedAt||newest[i-1].createdAt)>=Date.parse(p.publishedAt||p.createdAt)),'arrivals must be ordered by merchant publication time');
console.log('Merchandising regressions passed: sold/deleted hero fallback, empty catalog, no-photo cards/bag, newest listing order.');
