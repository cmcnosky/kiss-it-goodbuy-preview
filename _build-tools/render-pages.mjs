import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
function writeRenderedFile(file,content){const temporary=file+'.render-tmp';fs.writeFileSync(temporary,content);fs.renameSync(temporary,file);}
const flag=process.argv.indexOf('--dist');
const dist=flag>=0?path.resolve(process.argv[flag+1]):path.resolve(import.meta.dirname,'../dist');
const inventory=JSON.parse(fs.readFileSync(path.join(dist,'inventory.json'),'utf8'));
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const encode=x=>JSON.stringify(x).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026');
writeRenderedFile(path.join(dist,'inventory.js'),'window.KIGB_INVENTORY='+encode(inventory)+';\n');
// Change internal asset URLs with their contents; the shared page URL stays stable.
const assetFiles=['style.css','storefront.css','integration.css','catalog-normalize.js','inventory.js','catalog.js','commerce.js','storefront-data.js','app.js'];
const assetUrls=Object.fromEntries(assetFiles.map(file=>[file,file+'?v='+createHash('sha256').update(fs.readFileSync(path.join(dist,file))).digest('hex').slice(0,16)]));
const app=fs.readFileSync(path.join(dist,'app.js'),'utf8');
assert.ok(app.includes('// BROWSER START'));
const prefix=app.slice(0,app.indexOf('// BROWSER START'));
const setup=['catalog.js','commerce.js'].map(f=>fs.readFileSync(path.join(dist,f),'utf8')).join('\n');
function render(url,product){const context={location:new URL(url,'https://cmcnosky.github.io'),URL,URLSearchParams,Intl,Date,localStorage:{getItem:()=>null},KIGB_INVENTORY:inventory,KIGB_PRODUCT_HANDLE:product?.handle};context.window=context;const result=vm.runInNewContext(setup+'\n'+prefix+'\npageHtml()',context);assert.equal((result.match(/<h1[\s>]/g)||[]).length,1,'Exactly one H1 on '+url);return result;}
const siteUrl='https://cmcnosky.github.io/kiss-it-goodbuy-preview/';
// Give preview artwork an immutable content-based URL without changing the shared page URL.
const previewBytes=fs.readFileSync(path.join(dist,'assets/social-preview-kiss-it-good-buy-v9.png'));
const previewHash=createHash('sha256').update(previewBytes).digest('hex').slice(0,16);
const previewPath='assets/kiss-it-good-buy-gallery-'+previewHash+'.png';
writeRenderedFile(path.join(dist,previewPath),previewBytes);
assert.equal(previewBytes.readUInt32BE(16),1200,'Preview width');
assert.equal(previewBytes.readUInt32BE(20),630,'Preview height');
function html(body,{base='./',title,description,product,pagePath=''}={}){
const pageUrl=siteUrl+pagePath;
const photo=product?.images[0];
const image=photo?.src||siteUrl+previewPath;
const imageAlt=photo?.src?(photo.alt||product.title):'A photograph inside the Kiss It Good Buy showroom, the complete original lipstick-kiss logo, and a prominent dark business name on a pastel coral-red gallery label.';
const width=photo?.src?photo.width:1200;
const height=photo?.src?photo.height:630;
const imageType=photo?.src?({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[new URL(image).pathname.split('.').pop().toLowerCase()]):'image/png';
const imageDetails=(imageType?`<meta property="og:image:type" content="${imageType}">`:'')+(width>0&&height>0?`<meta property="og:image:width" content="${width}"><meta property="og:image:height" content="${height}">`:'');
return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${base}"><link rel="canonical" href="${escape(pageUrl)}"><title>${escape(title)} | Kiss It Good Buy</title><meta name="description" content="${escape(description)}"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#e58a78"><meta property="og:type" content="website"><meta property="og:site_name" content="Kiss It Good Buy"><meta property="og:url" content="${escape(pageUrl)}"><meta property="og:title" content="${escape(title)} | Kiss It Good Buy"><meta property="og:description" content="${escape(description)}"><meta property="og:image" content="${escape(image)}"><meta property="og:image:secure_url" content="${escape(image)}">${imageDetails}<meta property="og:image:alt" content="${escape(imageAlt)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(title)} | Kiss It Good Buy"><meta name="twitter:description" content="${escape(description)}"><meta name="twitter:image" content="${escape(image)}"><meta name="twitter:image:alt" content="${escape(imageAlt)}"><link rel="icon" href="assets/brand-original.png"><link rel="stylesheet" href="${assetUrls['style.css']}"><link rel="stylesheet" href="${assetUrls['storefront.css']}"><link rel="stylesheet" href="${assetUrls['integration.css']}">${product?'<script>window.KIGB_PRODUCT_HANDLE='+encode(product.handle)+'</script>':''}<script src="${assetUrls['catalog-normalize.js']}" defer></script><script src="${assetUrls['inventory.js']}" defer></script><script src="${assetUrls['catalog.js']}" defer></script><script src="${assetUrls['commerce.js']}" defer></script><script src="${assetUrls['storefront-data.js']}" defer></script><script src="${assetUrls['app.js']}" defer></script></head><body><a href="#main" class="skip-link">Skip to content</a><div id="app">${body}</div><noscript><div class="no-js"><p>Interactive filters, the bag, and live updates need JavaScript. <a href="https://kissitgoodbuy.net/collections/all">Shop directly at Kiss It Good Buy</a>.</p></div></noscript><div id="toast" class="toast" role="status" hidden></div></body></html>\n`;}
const pages={index:['A home with something to say','Explore distinctive furniture, art, and decor from Kiss It Good Buy in Grapevine. Shop the full inventory, compare your favorites, or consign a piece.'],collection:['Shop every good find','Browse the complete Kiss It Good Buy online inventory. Search by piece, brand, price, or item number, compare favorites, and buy through the store.'],story:['A Grapevine original since 2002','Discover the gallery, its history, and the eclectic furniture, art, and decor that give Kiss It Good Buy its character.'],consign:['Give a good piece its next chapter','Clear consignment terms, photo requirements, and an email helper for offering your furniture to Kiss It Good Buy.'],visit:['Visit the gallery','Visit Kiss It Good Buy at 201 East Franklin Street, Grapevine. Hours, directions, pickup, and contact details.'],shortlist:['Your shortlist','Compare your favorite pieces side by side, share your selection, and ask about exact item numbers.'],product:['A closer look','Explore a gallery piece, its photographs and details, and add it to your shopping bag.'],cart:['Your shopping bag','Review your pieces and continue to Kiss It Good Buy’s secure Shopify checkout.']};
for(const [name,[title,description]] of Object.entries(pages))writeRenderedFile(path.join(dist,name+'.html'),html(render('/'+name+'.html'),{title,description,pagePath:name==='index'?'':name+'.html'}));
fs.mkdirSync(path.join(dist,'products'),{recursive:true});
const handles=new Set(inventory.products.map(p=>p.handle));
for(const name of fs.readdirSync(path.join(dist,'products')))if(!handles.has(name))fs.rmSync(path.join(dist,'products',name),{recursive:true,force:true});
for(const product of inventory.products){assert.match(product.handle,/^[a-z0-9][a-z0-9-]*$/);const dir=path.join(dist,'products',product.handle);fs.mkdirSync(dir,{recursive:true});writeRenderedFile(path.join(dir,'index.html'),html(render('/products/'+product.handle+'/',product),{base:'../../',title:product.title,description:product.description.replace(/\s+/g,' ').slice(0,200),product,pagePath:'products/'+product.handle+'/'}));}
for(const url of ['/','/index','/index/','/collection','/collection/','/kiss-it-goodbuy-preview/','/cart','/shortlist'])render(url);
const allFiles=[...Object.keys(pages).map(x=>path.join(dist,x+'.html')),...inventory.products.map(p=>path.join(dist,'products',p.handle,'index.html'))];
let refs=0;
for(const file of allFiles){const content=fs.readFileSync(file,'utf8');for(const asset of assetFiles)assert.ok(content.includes('\"'+assetUrls[asset]+'\"'),path.relative(dist,file)+': missing content-versioned '+asset);}
for(const file of allFiles){const content=fs.readFileSync(file,'utf8');for(const match of content.matchAll(/(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)){const url=match[1];if(/^(https?:|mailto:|tel:|data:)/.test(url)||['./','../../'].includes(url))continue;assert.ok(fs.existsSync(path.join(dist,decodeURIComponent(url))),path.relative(dist,file)+': missing '+url);refs++;}}
for(const file of allFiles){
 const content=fs.readFileSync(file,'utf8');
 const tag=name=>content.match(new RegExp('<meta (?:property|name)="'+name+'" content="([^"]+)"'))?.[1];
 const canonical=content.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
 assert.equal(canonical,tag('og:url'),'Canonical and shared URL must agree');
 assert.ok(canonical?.startsWith(siteUrl)&&!canonical.includes('?'),'Permanent page addresses have no revision suffix');
 assert.equal(tag('og:image'),tag('twitter:image'),'Preview image must match across platforms');
 assert.equal(tag('og:image'),tag('og:image:secure_url'),'Secure image must match');
 assert.ok(tag('og:image').startsWith('https://'),'Preview image must be public HTTPS');
 if(tag('og:image')===siteUrl+previewPath){
  assert.equal(tag('og:image:width'),'1200');assert.equal(tag('og:image:height'),'630');
 }
}
console.log('Verified canonical URLs and matching Open Graph/Twitter preview metadata on every page.');
console.log(`Rendered ${allFiles.length} pages (${inventory.products.length} product pages); one H1 each; ${refs} local references verified.`);
