import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),dist=path.join(root,'dist');
const inventory=JSON.parse(fs.readFileSync(path.join(dist,'inventory.json'),'utf8'));
const app=fs.readFileSync(path.join(dist,'app.js'),'utf8').split('// BROWSER START')[0];
const context={location:new URL('https://example.test/collection.html'),URL,URLSearchParams,Intl,Date,KIGB_INVENTORY:inventory,localStorage:{getItem:()=>null}};context.window=context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(dist,'catalog-normalize.js'),'utf8')+'\n'+fs.readFileSync(path.join(dist,'catalog.js'),'utf8')+'\n'+fs.readFileSync(path.join(dist,'commerce.js'),'utf8')+'\n'+app,context);
const run=code=>vm.runInContext(code,context);
let fixtureSequence=0;
function fixtureProduct({
  title,
  handle,
  type='Chair',
  imageName='fixture-product.jpg',
  collections=[],
  available=true,
  publishedAt='2026-01-01T12:00:00Z',
  itemNumber,
  variants,
  tags=[]
}={}){
  const sequence=++fixtureSequence;
  const id=String(990000000000000+sequence);
  const fixtureVariants=variants||[{title:'Default Title',price:'125.00',available}];
  return {
    id,
    handle:handle||`fixture-product-${sequence}`,
    title:title||`Fixture product ${sequence}`,
    body_html:`<p>Item Number: ${itemNumber||`FIX-${sequence}`}</p><p>Synthetic storefront test fixture.</p>`,
    product_type:type,
    vendor:'Fixture Maker',
    tags,
    created_at:publishedAt,
    updated_at:publishedAt,
    published_at:publishedAt,
    images:imageName===null?[]:[{src:`https://fixtures.example/${imageName}`,alt:title||`Fixture product ${sequence}`}],
    variants:fixtureVariants.map((variant,index)=>({
      id:String(880000000000000+sequence*10+index),
      title:variant.title||'Default Title',
      available:variant.available??available,
      price:String(variant.price??'125.00'),
      compare_at_price:variant.compareAtPrice??null,
      sku:variant.sku||`${itemNumber||`FIX-${sequence}`}-${index+1}`,
      position:index+1
    })),
    options:fixtureVariants.length>1?[{name:'Value',position:1,values:fixtureVariants.map(variant=>variant.title)}]:[],
    _fixtureCollections:collections
  };
}
function setFixtureProducts(products){
  context.fixtureRawProducts=products;
  context.fixtureMemberships=Object.fromEntries(products.map(product=>[product.id,product._fixtureCollections||[]]));
  run('PRODUCTS=presentProducts(window.KIGBCatalog.normalizeProducts(fixtureRawProducts,{memberships:fixtureMemberships}));remoteOrder=null;remoteSearch=null;cartLines=[]');
  return run('PRODUCTS');
}
function editHandleFor(imageName){
  context.fixtureImageName=imageName;
  const handle=run('edits.find(product=>product.image.includes(fixtureImageName))?.handle');
  assert.ok(handle,`catalog.js must retain a handle mapping for ${imageName}`);
  return handle;
}
assert.equal(run('PRODUCTS.length'),inventory.products.length);
assert.deepEqual(
  JSON.parse(JSON.stringify(run('catalogCardinality(baseInventory.products)'))),
  {
    products: inventory.products.length,
    variants: inventory.products.reduce((total, product) => total + product.variants.length, 0)
  }
);
context.incompleteLiveCatalog=[inventory.products[0]];
assert.throws(
  ()=>run('assertLiveCatalogComplete(incompleteLiveCatalog)'),
  /Live catalog products fell/,
  'a syntactically valid but drastically incomplete live response must not replace the snapshot'
);
context.smallLegitimateRemoval=inventory.products.slice(1);
assert.doesNotThrow(
  ()=>run('assertLiveCatalogComplete(smallLegitimateRemoval)'),
  'a small ordinary removal must not disable live inventory'
);
const additionSource=structuredClone(inventory.products[0]);
additionSource.id='99999999999998';
additionSource.handle='synthetic-new-live-product';
additionSource.variants=additionSource.variants.map((variant,index)=>({...variant,id:String(99999999999000+index)}));
context.legitimateGrowth=[...inventory.products,additionSource];
assert.doesNotThrow(
  ()=>run('assertLiveCatalogComplete(legitimateGrowth)'),
  'newly published products must be accepted'
);
context.duplicateHandleCatalog=[...inventory.products,{...additionSource,id:'99999999999997',variants:additionSource.variants.map((variant,index)=>({...variant,id:String(99999999998000+index)})),handle:inventory.products[0].handle}];
assert.throws(
  ()=>run('assertLiveCatalogComplete(duplicateHandleCatalog)'),
  /duplicate product handle/,
  'duplicate handles must not create ambiguous product routes'
);
const initialProducts=run('PRODUCTS');
assert.ok(run('productHref(PRODUCTS[0])').startsWith('products/'));
const giftFixture=fixtureProduct({
  title:'Fixture Gift Card',
  type:'Gift Card',
  imageName:'fixture-gift-card.jpg',
  variants:[
    {title:'$50',price:'50.00',available:true},
    {title:'$100',price:'100.00',available:true},
    {title:'$250',price:'250.00',available:true}
  ]
});
const seatingFixture=fixtureProduct({title:'Fixture Searchable Chair',type:'Accent Chair',collections:['seating'],itemNumber:'TEST-42'});
const soldFixture=fixtureProduct({title:'Fixture Sold Table',type:'Table',collections:['tables'],available:false});
const availableFixture=fixtureProduct({title:'Fixture Available Painting',type:'Painting',collections:['art']});
const catalogFixtures=[
  giftFixture,
  seatingFixture,
  soldFixture,
  availableFixture,
  ...Array.from({length:25},(_,index)=>fixtureProduct({
    title:`Fixture catalog filler ${index+1}`,
    type:index%2?'Sideboard':'Chair',
    collections:[index%2?'tables':'seating'],
    publishedAt:`2026-02-${String((index%20)+1).padStart(2,'0')}T12:00:00Z`
  }))
];
setFixtureProducts(catalogFixtures);
assert.deepEqual([...run("filterProducts(PRODUCTS,filterState(new URLSearchParams('collection=seating'))).map(product=>product.handle)")],catalogFixtures.filter(product=>product._fixtureCollections.includes('seating')).map(product=>product.handle));
assert.deepEqual([...run("filterProducts(PRODUCTS,filterState(new URLSearchParams('q=gift%20card&min=100&budget=250'))).map(product=>product.handle)")],[giftFixture.handle],'variant range must match a qualifying gift-card denomination');
assert.equal(run("filterProducts(PRODUCTS,filterState(new URLSearchParams('q=TEST-42')))[0]?.itemNumber"),'TEST-42','item-number search must use normalized listing details');
assert.deepEqual([...run("filterProducts(PRODUCTS,filterState(new URLSearchParams('availability=sold'))).map(product=>product.handle)")],[soldFixture.handle]);
assert.equal(run("filterProducts(PRODUCTS,filterState(new URLSearchParams('min=1000&budget=10'))).length"),0);
assert.equal(run("filterState(new URLSearchParams('page=-9')).page"),1);
assert.equal(run("filterState(new URLSearchParams('budget=bad')).budget"),null);
assert.ok(run("filterUrl(filterState(),{q:'oak & teak',page:2})").includes('oak+%26+teak'));
assert.equal((run('catalogResults(filterState())').match(/<article class="product">/g)||[]).length,24);
assert.equal((run("catalogResults(filterState(new URLSearchParams('page=999')))" ).match(/<article class="product">/g)||[]).length,catalogFixtures.length%24||24);
run("remoteOrder={productIds:PRODUCTS.slice(0,2).map(p=>'gid://shopify/Product/'+p.id)}");
assert.equal(run("filterProducts(PRODUCTS,{...filterState(),sort:'relevance'}).length"),2,'Shopify GIDs must match normalized numeric IDs');
assert.equal(run("numericProductId('gid://shopify/Product/123')"),'123');
assert.equal(run("productHref({handle:'a-newly-published-piece'})"),'product.html?piece=a-newly-published-piece','new products must not require a static rebuild');
assert.ok(run("productCard(PRODUCTS.find(p=>isGiftCard(p)))").includes('denominations'));
assert.ok(!run("productCard(PRODUCTS.find(p=>isGiftCard(p)))").includes('Measurements'));
run('remoteOrder=null');
const parsed=run('pageHtml()');assert.ok(!parsed.includes('undefined'));assert.ok(!parsed.includes('NaN'));
console.log('Storefront integration checks passed: catalog/variants, GID matching, synthetic pagination and filtering, new-product routes, gift-card presentation, URL state.');

// Merchandising must remain truthful as one-off pieces sell or disappear.
const imageHandles=Object.fromEntries([
  'leopard-loveseat.jpg',
  'peacock-chair.jpg',
  'brenta-chandelier.jpg',
  'dragonfly-lamp.jpg',
  'g-plan-sideboard.jpg',
  'art-deco-fan-mirror.jpg',
  'birdhouse-painting.jpg',
  'medallion-sculpture.jpg'
].map(imageName=>[imageName,editHandleFor(imageName)]));

const displayGeneric=fixtureProduct({title:'Newest generic fallback',publishedAt:'2026-10-03T12:00:00Z'});
const displayLeopard=fixtureProduct({title:'Preferred fixture loveseat',handle:imageHandles['leopard-loveseat.jpg'],type:'Love Seat',publishedAt:'2026-01-01T12:00:00Z'});
const displayPeacock=fixtureProduct({title:'Preferred fixture peacock chair',handle:imageHandles['peacock-chair.jpg'],type:'Accent Chair',publishedAt:'2026-01-02T12:00:00Z'});
setFixtureProducts([displayGeneric,displayPeacock,displayLeopard]);
assert.deepEqual(
  [...run("displaySelection(['leopard-loveseat.jpg','peacock-chair.jpg'],3).map(product=>product.handle)")],
  [displayLeopard.handle,displayPeacock.handle,displayGeneric.handle],
  'available preferred pieces must retain their declared priority ahead of general fallbacks'
);

const soldPreferred=fixtureProduct({title:'Sold preferred fixture lamp',handle:imageHandles['dragonfly-lamp.jpg'],type:'Table Lamp',collections:['lamps'],available:false});
const fallbackOne=fixtureProduct({title:'Available fallback one'});
const fallbackTwo=fixtureProduct({title:'Available fallback two'});
const fallbackThree=fixtureProduct({title:'Available fallback three'});
setFixtureProducts([soldPreferred,fallbackOne,fallbackTwo,fallbackThree]);
const fallbackHandles=[...run("displaySelection(['dragonfly-lamp.jpg','peacock-chair.jpg'],3).map(product=>product.handle)")];
assert.deepEqual(fallbackHandles,[fallbackOne.handle,fallbackTwo.handle,fallbackThree.handle],'sold and missing preferred pieces must fall back to current photographed inventory');
assert.equal(new Set(fallbackHandles).size,3,'replacement merchandising slots must be distinct');

const onlyLight=fixtureProduct({title:'Only Eligible Fixture Lamp',type:'Table Lamp',collections:['lamps'],publishedAt:'2026-11-01T12:00:00Z'});
setFixtureProducts([onlyLight]);
const oneLightHome=run('home()');
assert.ok(oneLightHome.includes('Related find in the catalog')&&oneLightHome.includes('Only Eligible Fixture Lamp'),'the sole eligible light must remain the homepage related find');
assert.ok(!oneLightHome.includes('No available lighting is shown online right now.'),'the homepage must not claim there is no available lighting while its related find is an available light');

run('PRODUCTS=[]');
let emptyHome;
assert.doesNotThrow(()=>{emptyHome=run('home()');},'an empty catalog must not crash the homepage');
assert.equal((emptyHome.match(/class="empty chapter-empty"/g)||[]).length,3,'each editorial chapter must provide a useful no-match state');
assert.ok(emptyHome.includes('No available lighting is shown online right now.'));
assert.ok(emptyHome.includes('No available furniture or mirrors are shown online right now.'));
assert.ok(emptyHome.includes('No available art or objects are shown online right now.'));
assert.ok(emptyHome.includes('02 / FORM · From the online inventory'),'inventory wording must remain truthful when only the saved catalog is available');

const matchLamp=fixtureProduct({title:'Fixture Table Lamp',type:'Table Lamp',collections:['lamps']});
const matchMirror=fixtureProduct({title:'Fixture Art Deco Fan Mirror',type:'Wall Mirrors',collections:['mirrors-1']});
setFixtureProducts([matchLamp,matchMirror]);
assert.equal(run("chapterMatches.form(PRODUCTS.find(product=>product.handle==='"+matchLamp.handle+"'))"),false,'a table lamp must never leak into the FORM chapter');
assert.equal(run("chapterMatches.color(PRODUCTS.find(product=>product.handle==='"+matchMirror.handle+"'))"),false,'Art Deco in a mirror title must never make it COLOR artwork');

const chapterFixtures=[
  fixtureProduct({title:'Fixture Brenta Chandelier',handle:imageHandles['brenta-chandelier.jpg'],type:'Chandelier',collections:['ceiling-wall-1']}),
  fixtureProduct({title:'Fixture Dragonfly Lamp',handle:imageHandles['dragonfly-lamp.jpg'],type:'Table Lamp',collections:['lamps']}),
  fixtureProduct({title:'Fixture G Plan Sideboard',handle:imageHandles['g-plan-sideboard.jpg'],type:'Sideboard',collections:['tables']}),
  fixtureProduct({title:'Fixture Fan Mirror',handle:imageHandles['art-deco-fan-mirror.jpg'],type:'Wall Mirrors',collections:['mirrors-1']}),
  fixtureProduct({title:'Fixture Birdhouse Painting',handle:imageHandles['birdhouse-painting.jpg'],type:'Painting',collections:['art']}),
  fixtureProduct({title:'Fixture Medallion Sculpture',handle:imageHandles['medallion-sculpture.jpg'],type:'Sculpture',collections:['art']})
];
setFixtureProducts([...chapterFixtures].reverse());
const selectedChapterHandles=run(`(()=>{const used=new Set(),groups=[];for(const [images,match] of [[['brenta-chandelier.jpg','dragonfly-lamp.jpg'],chapterMatches.light],[['g-plan-sideboard.jpg','art-deco-fan-mirror.jpg'],chapterMatches.form],[['birdhouse-painting.jpg','medallion-sculpture.jpg'],chapterMatches.color]]){const group=chapterFinds(images,match,2,used);group.forEach(p=>used.add(p.id));groups.push(...group);}return groups.map(p=>p.handle).join('|');})()`);
const intendedChapterHandles=chapterFixtures.map(product=>product.handle).join('|');
assert.equal(selectedChapterHandles,intendedChapterHandles,'eligible preferred fixtures must take priority even when the general product order is reversed');
assert.equal(new Set(selectedChapterHandles.split('|')).size,6,'a product must not repeat across editorial chapters');
assert.equal(run(`(()=>{const first=chapterFinds([],chapterMatches.color,1),used=new Set(first.map(p=>p.id)),next=chapterFinds([],chapterMatches.color,1,used);return Boolean(first[0]&&next[0]&&first[0].id!==next[0].id);})()`),true,'chapter exclusions must force a distinct fallback when another qualifying item exists');

const datedChapterFixtures={
  light:[
    fixtureProduct({title:'Older fixture light',type:'Lamp',collections:['lamps'],publishedAt:'2026-03-01T12:00:00Z'}),
    fixtureProduct({title:'Newer fixture light',type:'Chandelier',collections:['ceiling-wall-1'],publishedAt:'2026-09-01T12:00:00Z'})
  ],
  form:[
    fixtureProduct({title:'Older fixture form',type:'Sideboard',collections:['tables'],publishedAt:'2026-02-01T12:00:00Z'}),
    fixtureProduct({title:'Newer fixture form',type:'Mirror',collections:['mirrors-1'],publishedAt:'2026-08-01T12:00:00Z'})
  ],
  color:[
    fixtureProduct({title:'Older fixture color',type:'Painting',collections:['art'],publishedAt:'2026-01-01T12:00:00Z'}),
    fixtureProduct({title:'Newer fixture color',type:'Sculpture',collections:['art'],publishedAt:'2026-07-01T12:00:00Z'})
  ]
};
setFixtureProducts(Object.values(datedChapterFixtures).flat());
for(const key of ['light','form','color']){
  const expected=[...datedChapterFixtures[key]].sort((left,right)=>Date.parse(right.published_at)-Date.parse(left.published_at)).map(product=>product.handle);
  assert.deepEqual([...run(`chapterFinds([],chapterMatches.${key},8).map(product=>product.handle)`)],expected,`${key} fallback products must be newest first`);
}

const noPhotoFixture=fixtureProduct({title:'Synthetic no-photo regression piece',imageName:null});
setFixtureProducts([noPhotoFixture]);
const missingMarkup=run('productCard(PRODUCTS[0])');
assert.ok(missingMarkup.includes('Photograph not supplied'));
assert.ok(missingMarkup.includes('src="assets/brand-original.png" alt=""'),'fallback brand artwork must not be described as a product photograph');
const missingCartMarkup=run(`(()=>{const p=PRODUCTS[0],v=p.variants.find(v=>v.available)||p.variants[0];cartLines=[{variantId:'gid://shopify/ProductVariant/'+v.id,quantity:1,productHandle:p.handle,productTitle:p.title,variantTitle:v.title,priceCents:v.priceCents,compareAtPriceCents:v.compareAtPriceCents,currencyCode:'USD',imageUrl:p.image,onlineStoreUrl:p.productUrl,available:true}];return cartContent();})()`);
assert.ok(missingCartMarkup.includes('cart-photo-missing'),'the bag must use an explicit no-photo treatment');
assert.ok(!missingCartMarkup.includes('<img src="assets/brand-original.png"'),'the bag must not present brand artwork as a product photograph');

const arrivalFixtures=[
  fixtureProduct({title:'Arrival 1',publishedAt:'2026-01-01T12:00:00Z'}),
  fixtureProduct({title:'Arrival 2',publishedAt:'2026-02-01T12:00:00Z'}),
  fixtureProduct({title:'Arrival 3',publishedAt:'2026-03-01T12:00:00Z'}),
  fixtureProduct({title:'Arrival 4',publishedAt:'2026-04-01T12:00:00Z'}),
  fixtureProduct({title:'Arrival 5',publishedAt:'2026-05-01T12:00:00Z'})
];
const excludedArrivalFixtures=[
  fixtureProduct({title:'Sold newest arrival',available:false,publishedAt:'2026-12-01T12:00:00Z'}),
  fixtureProduct({title:'No-photo newest arrival',imageName:null,publishedAt:'2026-11-01T12:00:00Z'}),
  fixtureProduct({title:'Gift Card newest arrival',type:'Gift Card',publishedAt:'2026-10-01T12:00:00Z'})
];
setFixtureProducts([...arrivalFixtures,...excludedArrivalFixtures]);
const newestHandles=[...run('latestFinds([]).map(product=>product.handle)')];
assert.deepEqual(newestHandles,[...arrivalFixtures].reverse().slice(0,4).map(product=>product.handle),'arrivals must be the four newest available photographed non-gift products');
assert.equal(new Set(newestHandles).size,newestHandles.length,'arrivals must not repeat');

context.testProducts=initialProducts;
run('PRODUCTS=testProducts;cartLines=[];remoteOrder=null;remoteSearch=null');
console.log('Merchandising regressions passed: preferred priority, sold/missing fallback, one-light homepage truthfulness, strict distinct chapters, useful empty states, no-photo cards/bag, newest listing order.');
