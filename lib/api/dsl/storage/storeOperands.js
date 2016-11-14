'use strict';

// Required to load node-interval-tree until Node implements the "import module" syntax
require('babel-polyfill');

// eslint-disable-next-line vars-on-top
var
  SortedArray = require('sorted-array'),
  strcmp = require('../util/stringCompare'),
  IntervalTree = require('node-interval-tree'),
  NotEqualsCondition = require('./objects/notEqualsCondition'),
  NotGeospatialCondition = require('./objects/notGeospatialCondition'),
  RegexpCondition = require('./objects/regexpCondition'),
  BoostSpatialIndex = require('boost-geospatial-index');

/**
 * Exposes a sets of methods meant to store operands in
 * the DSL keyword-specific part of a field-operand  object
 *
 * All provided <f,o> pair object references must point directly
 * to the right index/collection/keyword part of the structure
 *
 * @constructor
 */
function OperandsStorage () {
  return this;
}

/**
 * Stores an empty filter in the <f,o> pairs structure
 * There can never be more than 1 filter and subfilter for an
 * all-matching filter, for an index/collection pair
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 */
OperandsStorage.prototype.everything = function everything (foPairs, subfilter) {
  foPairs.fields.all = [subfilter];
};

/**
 * Stores a "equals" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.equals = function equals (foPairs, subfilter, condition) {
  var
    fieldName = Object.keys(condition.value)[0],
    value = condition.value[fieldName];

  if (!foPairs.fields[fieldName]) {
    foPairs.keys.insert(fieldName);
    foPairs.fields[fieldName] = {
      [value]: [subfilter]
    };
  }
  else if (foPairs.fields[fieldName][value]) {
    foPairs.fields[fieldName][value].push(subfilter);
  }
  else {
    foPairs.fields[fieldName][value] = [subfilter];
  }
};

/**
 * Stores a "not equals" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.notequals = function notequals (foPairs, subfilter, condition) {
  var
    fieldName = Object.keys(condition.value)[0],
    value = new NotEqualsCondition(condition.value[fieldName], subfilter),
    idx;

  if (!foPairs.fields[fieldName]) {
    foPairs.keys.insert(fieldName);
    foPairs.fields[fieldName] = {
      values: new SortedArray([value], (a, b) => strcmp(a.value, b.value))
    };
  }
  else if ((idx = foPairs.fields[fieldName].values.search(value)) >= 0) {
    foPairs.fields[fieldName].values.array[idx].subfilters.push(subfilter);
  }
  else {
    foPairs.fields[fieldName].values.insert(value);
  }
};

/**
 * Stores a "exists" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.exists = function exists (foPairs, subfilter, condition) {
  var
    fieldName = condition.value.field;

  if (!foPairs.fields[fieldName]) {
    foPairs.keys.insert(fieldName);
    foPairs.fields[fieldName] = [subfilter];
  }
  else {
    foPairs.fields[fieldName].push(subfilter);
  }
};

/**
 * Stores a "not exists" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.notexists = function notexists (foPairs, subfilter, condition) {
  this.exists(foPairs, subfilter, condition);
};

/**
 * Stores a "range" condition into the field-operand structure
 *
 * Stores the range in interval trees for searches in O(log n + m)
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.range = function range (foPairs, subfilter, condition) {
  var
    field = Object.keys(condition.value)[0],
    args = condition.value[field],
    low = -Infinity,
    high = Infinity;

  /*
   Initializes low and high values depending on condition arguments
   As the interval tree library used only considers inclusive boundaries,
   we need to add or substract an epsilon value to provided arguments
   for lt and gt options.
   */
  Object.keys(args).forEach(a => {
    if (['gt', 'gte'].indexOf(a) !== -1) {
      low = a === 'gt' ? args[a] + 1e-10 : args[a];
    }

    if (['lt', 'lte'].indexOf(a) !== -1) {
      high = a === 'lt' ? args[a] - 1e-10 : args[a];
    }
  });

  if (!foPairs.fields[field]) {
    foPairs.keys.insert(field);
    foPairs.fields[field] = {
      tree: new IntervalTree(),
      count: 1,
      subfilters: {
        [subfilter.id]: {subfilter, low, high}
      }
    };
  }
  else {
    foPairs.fields[field].subfilters[subfilter.id] = {subfilter, low, high};
    foPairs.fields[field].count++;
  }

  foPairs.fields[field].tree.insert(low, high, subfilter);
};

/**
 * Stores a "not range" condition into the field-operand structure
 *
 * "not range" conditions are stored as an inverted range,
 * meaning that if a user subscribes to the following range:
 *      [min, max]
 * Then we register the following ranges in the tree:
 *      ]-Infinity, min[
 *      ]max, +Infinity[
 *
 * (boundaries are also reversed: inclusive boundaries become
 * exclusive, and vice-versa)
 *
 * Matching is then executed exactly like for "range" conditions.
 * This does not hurt performances as searches in the interval tree
 * are in O(log n)
 *
 * (kudos to @asendra for this neat trick)
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.notrange = function notrange (foPairs, subfilter, condition) {
  var
    field = Object.keys(condition.value)[0],
    args = condition.value[field],
    low = -Infinity,
    high = Infinity;

  /*
   Initializes low and high values depending on condition arguments
   As the interval tree library used only considers inclusive boundaries,
   we need to add or substract an epsilon value to provided arguments
   for lte and gte options
   This is the reverse operation than the one done for the "range"
   keyword, as we then invert the searched range.
   */
  Object.keys(args).forEach(a => {
    if (['gt', 'gte'].indexOf(a) !== -1) {
      low = a === 'gte' ? args[a] - 1e-10 : args[a];
    }

    if (['lt', 'lte'].indexOf(a) !== -1) {
      high = a === 'lte' ? args[a] + 1e-10 : args[a];
    }
  });

  if (!foPairs.fields[field]) {
    foPairs.keys.insert(field);
    foPairs.fields[field] = {
      tree: new IntervalTree(),
      count: 1,
      subfilters: {
        [subfilter.id]: {subfilter, low, high}
      }
    };
  }
  else {
    foPairs.fields[field].subfilters[subfilter.id] = {subfilter, low, high};
    foPairs.fields[field].count++;
  }

  if (low !== -Infinity) {
    foPairs.fields[field].tree.insert(-Infinity, low, subfilter);
  }

  if (high !== Infinity) {
    foPairs.fields[field].tree.insert(high, Infinity, subfilter);
  }
};

/**
 * Stores a "regexp" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.regexp = function regexp (foPairs, subfilter, condition) {
  var
    fieldName = Object.keys(condition.value)[0],
    value = new RegexpCondition(condition.value[fieldName].value, subfilter, condition.value[fieldName].flags),
    idx;

  if (!foPairs.fields[fieldName]) {
    foPairs.keys.insert(fieldName);
    foPairs.fields[fieldName] = {
      expressions: new SortedArray([value], (a, b) => strcmp(a.stringValue, b.stringValue))
    };
  }
  else if ((idx = foPairs.fields[fieldName].expressions.search(value)) >= 0) {
    foPairs.fields[fieldName].expressions.array[idx].subfilters.push(subfilter);
  }
  else {
    foPairs.fields[fieldName].expressions.insert(value);
  }
};

/**
 * Stores a "not regexp" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.notregexp = function notregexp (foPairs, subfilter, condition) {
  this.regexp(foPairs, subfilter, condition);
};

/**
 * Stores a "geospatial" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.geospatial = function exists (foPairs, subfilter, condition) {
  var
    geotype = Object.keys(condition.value)[0],
    fieldName = Object.keys(condition.value[geotype])[0],
    value = condition.value[geotype][fieldName];

  if (!foPairs.custom.index) {
    foPairs.custom.index = new BoostSpatialIndex();
  }

  if (!foPairs.fields[fieldName]) {
    foPairs.keys.insert(fieldName);
    foPairs.fields[fieldName] = {
      [condition.id]: [subfilter]
    };
  }
  else if (foPairs.fields[fieldName][condition.id]) {
    foPairs.fields[fieldName][condition.id].push(subfilter);

    // skip the shape insertion in the geospatial index
    return;
  }
  else {
    foPairs.fields[fieldName][condition.id] = [subfilter];
  }

  storeGeoshape(foPairs.custom.index, geotype, condition.id, value);
};

/**
 * Stores a "not geospatial" condition into the field-operand structure
 *
 * @param {Object} foPairs
 * @param {Object} subfilter
 * @param {Object} condition
 */
OperandsStorage.prototype.notgeospatial = function exists (foPairs, subfilter, condition) {
  let
    geotype = Object.keys(condition.value)[0],
    fieldName = Object.keys(condition.value[geotype])[0],
    value = condition.value[geotype][fieldName],
    cond = new NotGeospatialCondition(condition.id, subfilter),
    idx;

  if (!foPairs.custom.index) {
    foPairs.custom.index = new BoostSpatialIndex();
  }

  if (!foPairs.fields[fieldName]) {
    foPairs.keys.insert(fieldName);
    foPairs.fields[fieldName] = {
      ids: new SortedArray([cond], (a, b) => strcmp(a.id, b.id))
    };
  }
  else if ((idx = foPairs.fields[fieldName].ids.search(cond)) !== -1) {
    foPairs.fields[fieldName].ids.array[idx].subfilters.push(subfilter);

    // skip the shape insertion in the geospatial index
    return;
  }
  else {
    foPairs.fields[fieldName].ids.insert(cond);
  }

  storeGeoshape(foPairs.custom.index, geotype, condition.id, value);
};

/**
 * Stores a geospatial shape in the provided index object.
 *
 * @param {Object} index
 * @param {String} type
 * @param {String} id
 * @param {Object|Array} shape
 */
function storeGeoshape(index, type, id, shape) {
  switch (type) {
    case 'geoBoundingBox':
      index.addBoundingBox(id,
        shape.bottom,
        shape.left,
        shape.top,
        shape.right
      );
      break;
    case 'geoDistance':
      index.addCircle(id, shape.lat, shape.lon, shape.distance);
      break;
    case 'geoDistanceRange':
      index.addAnnulus(id, shape.lat, shape.lon, shape.to, shape.from);
      break;
    case 'geoPolygon':
      index.addPolygon(id, shape);
      break;
  }
}

module.exports = OperandsStorage;
