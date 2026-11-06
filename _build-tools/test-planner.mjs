import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Planner=require('../dist/planner.js');

assert.equal(Planner.convertLength(10,'in','cm'),25.4);
assert.equal(Planner.convertLength(25.4,'cm','in'),10);
assert.equal(Planner.convertLength('', 'in','cm'),null);
assert.equal(Planner.number(-2),null);

const labeled=Planner.parseListedDimensions('88" W × 40" D × 34" H','labeled');
assert.deepEqual(labeled.axes,{width:88,depth:40,height:34});
assert.equal(labeled.unit,'in');
assert.equal(labeled.comparable,true);

const labeledMetric=Planner.parseListedDimensions('224 cm W × 102 cm D × 86 cm H','labeled');
assert.deepEqual(labeledMetric.axes,{width:224,depth:102,height:86});
assert.equal(labeledMetric.unit,'cm');
assert.equal(labeledMetric.comparable,true);

const unlabeledUnit=Planner.parseListedDimensions('88 W × 40 D × 34 H · made in Italy','labeled');
assert.equal(unlabeledUnit.unit,null);
assert.equal(unlabeledUnit.comparable,false);

const unlabeled=Planner.parseListedDimensions('73x20x32','unlabeled');
assert.deepEqual(unlabeled.values,[73,20,32]);
assert.equal(unlabeled.unit,null);
assert.equal(unlabeled.comparable,false);

const converted=Planner.convertPlan({unit:'in',doorWidth:36,doorHeight:80,notes:'tight turn'},'cm');
assert.equal(converted.doorWidth,91.44);
assert.equal(converted.doorHeight,203.2);
assert.equal(converted.notes,'tight turn');

const product={title:'Sofa',sourceProductType:'Sofas',itemNumber:'123',dimensionsRaw:'88" W x 40" D x 34" H',dimensions:{labelStatus:'labeled'},available:true,productUrl:'https://example.test/sofa'};
const warning=Planner.evaluateRoute(product,{unit:'in',doorWidth:32,doorHeight:80});
assert.equal(warning.kind,'check');
assert.match(warning.checks.join(' '),/simple side-pair orientations/);
assert.doesNotMatch(warning.checks.join(' '),/will not fit|cannot fit|fits/i);

const review=Planner.evaluateRoute(product,{unit:'in',doorWidth:50,doorHeight:90});
assert.equal(review.kind,'review');
assert.match(review.checks[0],/not a fit guarantee/i);

const uncertain=Planner.evaluateRoute({...product,dimensionsRaw:'88x40x34',dimensions:{labelStatus:'unlabeled'}},{unit:'in',doorWidth:32});
assert.equal(uncertain.kind,'confirm');
assert.match(uncertain.checks[0],/Confirm all three/i);

const missing=Planner.evaluateRoute({...product,dimensionsRaw:null,dimensions:null},{unit:'in',doorWidth:32});
assert.equal(missing.kind,'missing');

const noInput=Planner.evaluateRoute(product,{unit:'in'});
assert.equal(noInput.kind,'empty');
assert.match(noInput.title,/Add your measurements/);

const oneOpeningDimension=Planner.evaluateRoute(product,{unit:'in',doorWidth:32});
assert.equal(oneOpeningDimension.kind,'check');
assert.match(oneOpeningDimension.checks[0],/both doorway width and height/);

const partialConfirmed=Planner.evaluateRoute({...product,dimensionsRaw:'88x40x34',dimensions:{labelStatus:'unlabeled'}},{unit:'in',doorWidth:32,doorHeight:80},{unit:'in',width:88});
assert.equal(partialConfirmed.kind,'confirm');
assert.match(partialConfirmed.title,/Complete your confirmed measurements/);

const completeConfirmed=Planner.evaluateRoute({...product,dimensionsRaw:'88x40x34',dimensions:{labelStatus:'unlabeled'}},{unit:'in',doorWidth:32,doorHeight:80},{unit:'in',width:88,depth:40,height:34});
assert.equal(completeConfirmed.kind,'check');
assert.equal(completeConfirmed.parsed.source,'shopper-confirmed');

const fraction=Planner.parseListedDimensions('34 1/2" W x 20" D','labeled');
assert.equal(fraction.comparable,false);
assert.equal(fraction.unsupported,true);
assert.equal(Planner.parseListedDimensions('80 cm W x 30" D','labeled').comparable,false);
assert.equal(Planner.parseListedDimensions("6' 2\" H",'labeled').comparable,false);

const original={unit:'in',doorWidth:33.3,doorHeight:79.75,notes:'keep this'};
const roundTrip=Planner.convertPlan(Planner.convertPlan(original,'cm'),'in');
assert.equal(roundTrip.doorWidth,original.doorWidth);
assert.equal(roundTrip.doorHeight,original.doorHeight);
assert.equal(roundTrip.notes,original.notes);

const worksheet=Planner.buildWorksheet({plan:{unit:'in',doorWidth:32,doorHeight:80,notes:'One tight turn'},products:[product,{title:'Gift Card',sourceProductType:'Gift Card'}],confirmedByProduct:{},inventoryStatus:'Inventory checked now.'});
assert.match(worksheet,/Item: 123/);
assert.match(worksheet,/One tight turn/);
assert.match(worksheet,/Saving a piece does not hold or reserve it/);
assert.doesNotMatch(worksheet,/Gift Card/);

console.log('Planner unit conversion, cautious comparisons, uncertainty, and worksheet checks passed.');
