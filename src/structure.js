'use strict';

var Immutable = require('immutable');
var Cursor = require('immutable/contrib/cursor/index');
var EventEmitter = require('eventemitter3');
var utils = require('./utils');

var LISTENER_SENTINEL = {};

 /**
 * Creates a new `Structure` instance. Also accessible through
 * `Immstruct.Structre`.
 *
 * A structure is also an EventEmitter object, so it has methods as
 * `.on`, `.off`, and all other EventEmitter methods.
 *
 * ### Examples:
 *
 *     var Structure = require('immstruct/structure');
 *     var s = new Structure({ data: { foo: 'bar' }});
 *
 *     // Or:
 *     // var Structure = require('immstruct').Structure;
 *
 * ### Events
 *
 * * `swap`: Emitted when cursor is updated (new information is set). Emits no values. One use case for this is to re-render design components. Callback is passed arguments: `newStructure`, `oldStructure`, `keyPath`.
 * * `next-animation-frame`: Same as `swap`, but only emitted on animation frame. Could use with many render updates and better performance. Callback is passed arguments: `newStructure`, `oldStructure`, `keyPath`.
 * * `change`: Emitted when data/value is updated and it existed before. Emits values: `newValue`, `oldValue` and `path`.
 * * `delete`: Emitted when data/value is removed. Emits value:  `removedValue` and `path`.
 * * `add`: Emitted when new data/value is added. Emits value: `newValue` and `path`.
 *
 * ### Options
 *
 * ```
 * {
 *   key: String, // Defaults to random string
 *   data: Object|Immutable, // defaults to empty Map
 *   history: Boolean, // Defaults to false
 *   historyLimit: Number, // If history enabled, Defaults to Infinity
 * }
 * ```
 *
 * @property {Immutable.List} history `Immutable.List` with history.
 * @property {Object|Immutable} current Provided data as immutable data
 * @property {String} key Generated or provided key.
 *
 *
 * @param {{ key: String, data: Object, history: Boolean }} [options] - defaults to random key and empty data (immutable structure). No history
 *
 * @constructor
 * @class {Structure}
 * @returns {Structure}
 * @api public
 */
function Structure (options) {
  var self = this;

  options = options || {};
  if (!(this instanceof Structure)) {
    return new Structure(options);
  }

  this.key = options.key || utils.generateRandomKey();

  this._queuedChange = false;
  this.current = options.data;
  if (!isImmutableStructure(this.current) || !this.current) {
    this.current = Immutable.fromJS(this.current || {});
  }

  if (!!options.history) {
    this.history = Immutable.List.of(this.current);
    this._currentRevision = 0;
    this._historyLimit = (typeof options.historyLimit === 'number') ?
      options.historyLimit :
      Infinity;
  }

  this._referencelisteners = Immutable.Map();
  this.on('swap', function (newData, oldData, keyPath) {
    var path, args = [newData, oldData, keyPath];
    if (!keyPath || keyPath.length === 0) {
      return emit(self._referencelisteners, newData, oldData, [], args);
    }

    path = keyPath[0];
    emit(self._referencelisteners.get(path), newData.get(path), oldData.get(path),
      keyPath.slice(1), args);
  });

  EventEmitter.call(this, arguments);
}
inherits(Structure, EventEmitter);
module.exports = Structure;

function emit(map, newData, oldData, path, args) {
  if (!map || newData === oldData) return;
  map.get(LISTENER_SENTINEL, []).forEach(function (fn) {
    fn.apply(null, args);
  });

  if (path.length > 0) {
    var nextPathRoot = path[0];
    if (!newData.get) return;
    return emit(map.get(nextPathRoot), newData.get(nextPathRoot),
      oldData.get(nextPathRoot), path.slice(1), args);
  }

  map.forEach(function(value, key) {
    if (key === LISTENER_SENTINEL) return;
    var passedNewData = (newData && newData.get) ? newData.get(key) : newData;
    var passedOldData = (oldData && oldData.get) ? oldData.get(key) : oldData;
    emit(value, passedNewData, passedOldData, [], args);
  });
}

/**
 * Create a Immutable.js Cursor for a given `path` on the `current` structure (see `Structure.current`).
 * Changes made through created cursor will cause a `swap` event to happen (see `Events`).
 *
 * ### Examples:
 *
 *     var Structure = require('immstruct/structure');
 *     var s = new Structure({ data: { foo: 'bar', a: { b: 'foo' } }});
 *     s.cursor().set('foo', 'hello');
 *     s.cursor('foo').update(function () { return 'Changed'; });
 *     s.cursor(['a', 'b']).update(function () { return 'bar'; });
 *
 * See more examples in the [tests](https://github.com/omniscientjs/immstruct/blob/master/tests/structure_test.js)
 *
 * @param {String|Array} [path] - defaults to empty string. Can be array for path. See Immutable.js Cursors
 *
 * @api public
 * @module structure.cursor
 * @returns {Cursor} Gives a Cursor from Immutable.js
 */
Structure.prototype.cursor = function (path) {
  var self = this;
  path = valToKeyPath(path) || [];

  if (!this.current) {
    throw new Error('No structure loaded.');
  }

  var changeListener = function (newRoot, oldRoot, path) {
    if(self.current === oldRoot) {
      self.current = newRoot;
    } else if(!hasIn(newRoot, path)) {
      // Othewise an out-of-sync change occured. We ignore `oldRoot`, and focus on
      // changes at path `path`, and sync this to `self.current`.
      self.current = self.current.removeIn(path);
    } else {
      // Update an existing path or add a new path within the current map.
      self.current = self.current.setIn(path, newRoot.getIn(path));
    }

    return self.current;
  };

  changeListener = handleHistory(this, changeListener);
  changeListener = handleSwap(this, changeListener);
  changeListener = handlePersisting(this, changeListener);
  return Cursor.from(self.current, path, changeListener);
};

/**
 * Creates a reference. A reference can be a pointer to a cursor, allowing
 * you to create cursors for a specific path any time. This is essentially
 * a way to have "always updated cursors" or Reference Cursors. See example
 * for better understanding the concept.
 *
 * References also allow you to listen for changes specific for a path.
 *
 * ### Examples:
 *
 *     var structure = immstruct({
 *       someBox: { message: 'Hello World!' }
 *     });
 *     var ref = structure.reference(['someBox']);
 *
 *     var unobserve = ref.observe(function () {
 *       // Called when data the path 'someBox' is changed.
 *       // Also called when the data at ['someBox', 'message'] is changed.
 *     });
 *
 *     // Update the data using the ref
 *     ref.cursor().update(function () { return 'updated'; });
 *
 *     // Update the data using the initial structure
 *     structure.cursor(['someBox', 'message']).update(function () { return 'updated again'; });
 *
 *     // Remove the listener
 *     unobserve();
 *
 * See more examples in the [readme](https://github.com/omniscientjs/immstruct)
 *
 * @param {String|Array} [path] - defaults to empty string. Can be array for path. See Immutable.js Cursors
 *
 * @api public
 * @module structure.reference
 * @returns {Reference}
 * @constructor
 */
Structure.prototype.reference = function (path) {
  if (isCursor(path) && path._keyPath) {
    path = path._keyPath;
  }

  path = valToKeyPath(path) || [];

  var self = this,
      cursor = this.cursor(path),
      unobservers = Immutable.Set();

  function cursorRefresher() {cursor = self.cursor(path); }
  function _subscribe (path, fn) {
    self._referencelisteners = subscribe(self._referencelisteners, path, fn);
  }
  function _unsubscribe (path, fn) {
    self._referencelisteners = unsubscribe(self._referencelisteners, path, fn);
  }

  _subscribe(path, cursorRefresher);

  return {
    /**
     * Observe for changes on a reference. On references you can observe for changes,
     * but a reference **is not** an EventEmitter it self.
     *
     * ### Examples:
     *
     *     var ref = structure.reference(['someBox']);
     *
     *     var unobserve = ref.observe('delete', function () {
     *       // Called when data the path 'someBox' is removed from the structure.
     *     });
     *
     * See more examples in the [readme](https://github.com/omniscientjs/immstruct)
     *
     * ### Events
     * * `swap`: Emitted when cursor is updated (new information is set). Emits no values. One use case for this is to re-render design components. Callback is passed arguments: `newStructure`, `oldStructure`, `keyPath`.
     * * `change`: Emitted when data/value is updated and it existed before. Emits values: `newValue`, `oldValue` and `path`.
     * * `delete`: Emitted when data/value is removed. Emits value:  `removedValue` and `path`.
     * * `add`: Emitted when new data/value is added. Emits value: `newValue` and `path`.
     *
     *
     * @param {String} [eventName] - Type of change
     * @param {Function} callback - Callback when referenced data is swapped
     *
     * @api public
     * @module reference.observe
     * @returns {Function} Function for removing observer (unobserve)
     */
    observe: function (eventName, newFn) {
      if (typeof eventName === 'function') {
        newFn = eventName;
        eventName = void 0;
      }
      if (this._dead || typeof newFn !== 'function') return;
      if (eventName && eventName !== 'swap') {
        newFn = onlyOnEvent(eventName, newFn);
      }

      _subscribe(path, newFn);
      unobservers = unobservers.add(newFn);

      return function unobserve () {
        _unsubscribe(path, newFn);
      };
    },

    /**
     * Create a new, updated, cursor from the base path provded to the
     * reference. This returns a Immutable.js Cursor as the regular
     * cursor method. You can also provide a sub-path to create a reference
     * in a deeper level.
     *
     * ### Examples:
     *
     *     var ref = structure.reference(['someBox']);
     *     var cursor = ref.cursor('someSubPath');
     *     var cursor2 = ref.cursor();
     *
     * See more examples in the [readme](https://github.com/omniscientjs/immstruct)
     *
     * @param {String} [subpath] - Subpath to a deeper structure
     *
     * @api public
     * @module reference.cursor
     * @returns {Cursor} Immutable.js cursor
     */
    cursor: function (subPath) {
      if (this._dead) return void 0;
      subPath = valToKeyPath(subPath);
      if (subPath) return cursor.cursor(subPath);
      return cursor;
    },

    /**
     * Remove all observers from reference.
     *
     * @api public
     * @module reference.unobserveAll
     * @returns {Void}
     */
    unobserveAll: function (destroy) {
      if (this._dead) return void 0;
      unobservers.forEach(function(fn) {
        _unsubscribe(path, fn);
      });

      if (destroy) {
        _unsubscribe(path, cursorRefresher);
      }
    },

    /**
     * Destroy reference. Unobserve all observers, set all endpoints of reference to dead.
     * For cleaning up memory.
     *
     * @api public
     * @module reference.destroy
     * @returns {Void}
     */
    destroy: function () {
      cursor = void 0;
      this.unobserveAll(true);

      this._dead = true;
      this.observe = void 0;
      this.unobserveAll = void 0;
      this.cursor = void 0;
      this.destroy = void 0;

      cursorRefresher = void 0;
      _unsubscribe = void 0;
      _subscribe = void 0;
    }
  };
};

/**
 * Force emitting swap event. Pass on new, old and keypath passed to swap.
 * If newData is `null` current will be used.
 *
 * @param {Object} newData - Immutable object for the new data to emit
 * @param {Object} oldData - Immutable object for the old data to emit
 * @param {String} keyPath - Structure path (in tree) to where the changes occured.
 *
 * @api public
 * @module structure.forceHasSwapped
 * @returns {Void}
 */
Structure.prototype.forceHasSwapped = function (newData, oldData, keyPath) {
  this.emit('swap', newData || this.current, oldData, keyPath);
  possiblyEmitAnimationFrameEvent(this, newData || this.current, oldData, keyPath);
};


/**
 * Undo IFF history is activated and there are steps to undo. Returns new current
 * immutable structure.
 *
 * **Will NOT emit swap when redo. You have to do this yourself**.
 *
 * Define number of steps to undo in param.
 *
 * @param {Number} steps - Number of steps to undo
 *
 * @api public
 * @module structure.undo
 * @returns {Object} New Immutable structure after undo
 */
Structure.prototype.undo = function(steps) {
  this._currentRevision -= steps || 1;
  if (this._currentRevision < 0) {
    this._currentRevision = 0;
  }

  this.current = this.history.get(this._currentRevision);
  return this.current;
};

/**
 * Redo IFF history is activated and you can redo. Returns new current immutable structure.
 * Define number of steps to redo in param.
 * **Will NOT emit swap when redo. You have to do this yourself**.
 *
 * @param {Number} head - Number of steps to head to in redo
 *
 * @api public
 * @module structure.redo
 * @returns {Object} New Immutable structure after redo
 */
Structure.prototype.redo = function(head) {
  this._currentRevision += head || 1;
  if (this._currentRevision > this.history.count() - 1) {
    this._currentRevision = this.history.count() - 1;
  }

  this.current = this.history.get(this._currentRevision);
  return this.current;
};

/**
 * Undo IFF history is activated and passed `structure` exists in history.
 * Returns the same immutable structure as passed as argument.
 *
 * **Will NOT emit swap after undo. You have to do this yourself**.
 *
 * @param {Object} structure - Immutable structure to redo until
 *
 * @api public
 * @module structure.undoUntil
 * @returns {Object} New Immutable structure after undo
 */
Structure.prototype.undoUntil = function(structure) {
  this._currentRevision = this.history.indexOf(structure);
  this.current = structure;

  return structure;
};


function subscribe(listeners, path, fn) {
  return listeners.updateIn(path.concat(LISTENER_SENTINEL), Immutable.OrderedSet(), function(old) {
    return old.add(fn);
  });
}

function unsubscribe(listeners, path, fn) {
  return listeners.updateIn(path.concat(LISTENER_SENTINEL), Immutable.OrderedSet(), function(old) {
    return old.remove(fn);
  });
}

// Private decorators.

// Update history if history is active
function handleHistory (emitter, fn) {
  return function handleHistoryFunction (newData, oldData, path) {
    var newStructure = fn.apply(fn, arguments);
    if (!emitter.history || (newData === oldData)) return newStructure;

    emitter.history = emitter.history
      .take(++emitter._currentRevision)
      .push(emitter.current);

    if (emitter.history.size > emitter._historyLimit) {
      emitter.history = emitter.history.takeLast(emitter._historyLimit);
      emitter._currentRevision -= (emitter.history.size - emitter._historyLimit);
    }

    return newStructure;
  };
}

var _requestAnimationFrame = (typeof window !== 'undefined' && window.requestAnimationFrame) || function () { };

// Update history if history is active
function possiblyEmitAnimationFrameEvent (emitter, newStructure, oldData, keyPath) {
  if (emitter._queuedChange) return;
  emitter._queuedChange = true;

  _requestAnimationFrame(function () {
    emitter._queuedChange = false;
    emitter.emit('next-animation-frame', newStructure, oldData, keyPath);
  });
}

// Emit swap event on values are swapped
function handleSwap (emitter, fn) {
  return function handleSwapFunction (newData, oldData, keyPath) {
    var newStructure = fn.apply(fn, arguments);
    if(newData === oldData) return newStructure;

    emitter.emit('swap', newStructure, oldData, keyPath);
    possiblyEmitAnimationFrameEvent(emitter, newStructure, oldData, keyPath);

    return newStructure;
  };
}

// Map changes to update events (delete/change/add).
function handlePersisting (emitter, fn) {
  return function handlePersistingFunction (newData, oldData, path) {
    var newStructure = fn.apply(fn, arguments);
    if(newData === oldData) return newStructure;
    var info = analyze(newData, oldData, path);

    if (info.eventName) {
      emitter.emit.apply(emitter, [info.eventName].concat(info.args));
    }
    return newStructure;
  };
}

// Private helpers.

function unobserver(listenerNs, observerFn) {
  return function() {
    var fnIndex = listenerNs.indexOf(observerFn);
    if (fnIndex > -1) {
      listenerNs.splice(fnIndex, 1);
    }
  }
}

function analyze (newData, oldData, path) {
  var oldObject = oldData && oldData.getIn(path);
  var newObject = newData && newData.getIn(path);

  var inOld = oldData && hasIn(oldData, path);
  var inNew = newData && hasIn(newData, path);

  var args, eventName;

  if (inOld && !inNew) {
    eventName = 'delete';
    args = [oldObject, path];
  } else if (inOld && inNew) {
    eventName = 'change';
    args = [newObject, oldObject, path];
  } else if (!inOld && inNew) {
    eventName = 'add';
    args = [newObject, path];
  }

  return {
    eventName: eventName,
    args: args
  };
}

// Check if path exists.
var NOT_SET = {};
function hasIn(cursor, path) {
  if(cursor.hasIn) return cursor.hasIn(path);
  return cursor.getIn(path, NOT_SET) !== NOT_SET;
}

function onlyOnEvent(eventName, fn) {
  return function (newData, oldData, keyPath) {
    var info = analyze(newData, oldData, keyPath);
    if (info.eventName !== eventName) return;
    return fn.apply(fn, info.args);
  };
}

function isCursor (potential) {
  return potential && typeof potential.deref === 'function';
}

// Check if passed structure is existing immutable structure.
// From https://github.com/facebook/immutable-js/wiki/Upgrading-to-Immutable-v3#additional-changes
var immutableCheckers = [
  {name: 'Iterable', method: 'isIterable' },
  {name: 'Seq', method: 'isSeq'},
  {name: 'Map', method: 'isMap'},
  {name: 'OrderedMap', method: 'isOrderedMap'},
  {name: 'List', method: 'isList'},
  {name: 'Stack', method: 'isStack'},
  {name: 'Set', method: 'isSet'}
];
function isImmutableStructure (data) {
  return immutableCheckers.some(function (checkItem) {
    return immutableSafeCheck(checkItem.name, checkItem.method, data);
  });
}

function immutableSafeCheck (ns, method, data) {
  return Immutable[ns] && Immutable[ns][method] && Immutable[ns][method](data);
}

function valToKeyPath(val) {
  if (typeof val === 'undefined') {
    return val;
  }
  return Array.isArray(val) ? val :
    immutableSafeCheck('Iterable', 'isIterable', val) ?
      val.toArray() : [val];
}

function inherits (c, p) {
  var e = {};
  Object.getOwnPropertyNames(c.prototype).forEach(function (k) {
    e[k] = Object.getOwnPropertyDescriptor(c.prototype, k)
  });
  c.prototype = Object.create(p.prototype, e)
  c['super'] = p
}
