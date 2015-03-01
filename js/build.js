"format register";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";
    
    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;
    
    // we never overwrite an existing define
    if (!defined[name])
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      
      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;
      
      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {
        
        // if already in a group, remove from the old group
        if (depEntry.groupIndex) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });
    
    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);
    
      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);
    
    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.declarative ? entry.module.exports : { 'default': entry.module.exports, '__useDefault': true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(main, declare) {

    var System;

    // if there's a system loader, define onto it
    if (typeof System != 'undefined' && System.register) {
      declare(System);
      System['import'](main);
    }
    // otherwise, self execute
    else {
      declare(System = {
        register: register, 
        get: load, 
        set: function(name, module) {
          modules[name] = module; 
        },
        newModule: function(module) {
          return module;
        },
        global: global 
      });
      load(main);
    }
  };

})(typeof window != 'undefined' ? window : global)
/* ('mainModule', function(System) {
  System.register(...);
}); */
('lib/main', function(System) {




System.register("npm:ms@0.6.2/index", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var s = 1000;
  var m = s * 60;
  var h = m * 60;
  var d = h * 24;
  var y = d * 365.25;
  module.exports = function(val, options) {
    options = options || {};
    if ('string' == typeof val)
      return parse(val);
    return options.long ? long(val) : short(val);
  };
  function parse(str) {
    var match = /^((?:\d+)?\.?\d+) *(ms|seconds?|s|minutes?|m|hours?|h|days?|d|years?|y)?$/i.exec(str);
    if (!match)
      return;
    var n = parseFloat(match[1]);
    var type = (match[2] || 'ms').toLowerCase();
    switch (type) {
      case 'years':
      case 'year':
      case 'y':
        return n * y;
      case 'days':
      case 'day':
      case 'd':
        return n * d;
      case 'hours':
      case 'hour':
      case 'h':
        return n * h;
      case 'minutes':
      case 'minute':
      case 'm':
        return n * m;
      case 'seconds':
      case 'second':
      case 's':
        return n * s;
      case 'ms':
        return n;
    }
  }
  function short(ms) {
    if (ms >= d)
      return Math.round(ms / d) + 'd';
    if (ms >= h)
      return Math.round(ms / h) + 'h';
    if (ms >= m)
      return Math.round(ms / m) + 'm';
    if (ms >= s)
      return Math.round(ms / s) + 's';
    return ms + 'ms';
  }
  function long(ms) {
    return plural(ms, d, 'day') || plural(ms, h, 'hour') || plural(ms, m, 'minute') || plural(ms, s, 'second') || ms + ' ms';
  }
  function plural(ms, n, name) {
    if (ms < n)
      return;
    if (ms < n * 1.5)
      return Math.floor(ms / n) + ' ' + name;
    return Math.ceil(ms / n) + ' ' + name + 's';
  }
  global.define = __define;
  return module.exports;
});



System.register("lib/trends-item", [], function($__export) {
  "use strict";
  var __moduleName = "lib/trends-item";
  return {
    setters: [],
    execute: function() {
      $__export('default', (function(items) {
        return items;
      }));
    }
  };
});



System.register("lib/trends-view", [], function($__export) {
  "use strict";
  var __moduleName = "lib/trends-view";
  return {
    setters: [],
    execute: function() {
      $__export('default', (function(items) {
        var elem = document.querySelector('#goo_sea_tre');
        var str = "";
        var mapping = JSON.parse('{"1":"All Regions","30":"Argentina","8":"Australia","44":"Austria","41":"Belgium","18":"Brazil","13":"Canada","38":"Chile","32":"Colombia","43":"Czech Republic","49":"Denmark","29":"Egypt","50":"Finland","16":"France","15":"Germany","48":"Greece","10":"Hong Kong","45":"Hungary","3":"India","19":"Indonesia","6":"Israel","27":"Italy","4":"Japan","37":"Kenya","34":"Malaysia","21":"Mexico","17":"Netherlands","52":"Nigeria","51":"Norway","25":"Philippines","31":"Poland","47":"Portugal","39":"Romania","14":"Russia","36":"Saudi Arabia","5":"Singapore","40":"South Africa","23":"South Korea","26":"Spain","42":"Sweden","46":"Switzerland","12":"Taiwan","33":"Thailand","24":"Turkey","35":"Ukraine","9":"United Kingdom","1":"United States","28":"Vietnam"}');
        for (var item in items) {
          str += ("<h2>" + mapping[item] + "</h2><ul>");
          str += items[item].map((function(searchStr) {
            return ("<li>" + searchStr + "</li>");
          })).join("");
          str += "</ul>";
        }
        elem.innerHTML = str;
      }));
    }
  };
});



System.register("npm:ms@0.6.2", ["npm:ms@0.6.2/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:ms@0.6.2/index");
  global.define = __define;
  return module.exports;
});



System.register("npm:debug@2.1.1/debug", ["npm:ms@0.6.2"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports = module.exports = debug;
  exports.coerce = coerce;
  exports.disable = disable;
  exports.enable = enable;
  exports.enabled = enabled;
  exports.humanize = require("npm:ms@0.6.2");
  exports.names = [];
  exports.skips = [];
  exports.formatters = {};
  var prevColor = 0;
  var prevTime;
  function selectColor() {
    return exports.colors[prevColor++ % exports.colors.length];
  }
  function debug(namespace) {
    function disabled() {}
    disabled.enabled = false;
    function enabled() {
      var self = enabled;
      var curr = +new Date();
      var ms = curr - (prevTime || curr);
      self.diff = ms;
      self.prev = prevTime;
      self.curr = curr;
      prevTime = curr;
      if (null == self.useColors)
        self.useColors = exports.useColors();
      if (null == self.color && self.useColors)
        self.color = selectColor();
      var args = Array.prototype.slice.call(arguments);
      args[0] = exports.coerce(args[0]);
      if ('string' !== typeof args[0]) {
        args = ['%o'].concat(args);
      }
      var index = 0;
      args[0] = args[0].replace(/%([a-z%])/g, function(match, format) {
        if (match === '%%')
          return match;
        index++;
        var formatter = exports.formatters[format];
        if ('function' === typeof formatter) {
          var val = args[index];
          match = formatter.call(self, val);
          args.splice(index, 1);
          index--;
        }
        return match;
      });
      if ('function' === typeof exports.formatArgs) {
        args = exports.formatArgs.apply(self, args);
      }
      var logFn = enabled.log || exports.log || console.log.bind(console);
      logFn.apply(self, args);
    }
    enabled.enabled = true;
    var fn = exports.enabled(namespace) ? enabled : disabled;
    fn.namespace = namespace;
    return fn;
  }
  function enable(namespaces) {
    exports.save(namespaces);
    var split = (namespaces || '').split(/[\s,]+/);
    var len = split.length;
    for (var i = 0; i < len; i++) {
      if (!split[i])
        continue;
      namespaces = split[i].replace(/\*/g, '.*?');
      if (namespaces[0] === '-') {
        exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
      } else {
        exports.names.push(new RegExp('^' + namespaces + '$'));
      }
    }
  }
  function disable() {
    exports.enable('');
  }
  function enabled(name) {
    var i,
        len;
    for (i = 0, len = exports.skips.length; i < len; i++) {
      if (exports.skips[i].test(name)) {
        return false;
      }
    }
    for (i = 0, len = exports.names.length; i < len; i++) {
      if (exports.names[i].test(name)) {
        return true;
      }
    }
    return false;
  }
  function coerce(val) {
    if (val instanceof Error)
      return val.stack || val.message;
    return val;
  }
  global.define = __define;
  return module.exports;
});



System.register("npm:debug@2.1.1/browser", ["npm:debug@2.1.1/debug"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports = module.exports = require("npm:debug@2.1.1/debug");
  exports.log = log;
  exports.formatArgs = formatArgs;
  exports.save = save;
  exports.load = load;
  exports.useColors = useColors;
  var storage;
  if (typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined')
    storage = chrome.storage.local;
  else
    storage = window.localStorage;
  exports.colors = ['lightseagreen', 'forestgreen', 'goldenrod', 'dodgerblue', 'darkorchid', 'crimson'];
  function useColors() {
    return ('WebkitAppearance' in document.documentElement.style) || (window.console && (console.firebug || (console.exception && console.table))) || (navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31);
  }
  exports.formatters.j = function(v) {
    return JSON.stringify(v);
  };
  function formatArgs() {
    var args = arguments;
    var useColors = this.useColors;
    args[0] = (useColors ? '%c' : '') + this.namespace + (useColors ? ' %c' : ' ') + args[0] + (useColors ? '%c ' : ' ') + '+' + exports.humanize(this.diff);
    if (!useColors)
      return args;
    var c = 'color: ' + this.color;
    args = [args[0], c, 'color: inherit'].concat(Array.prototype.slice.call(args, 1));
    var index = 0;
    var lastC = 0;
    args[0].replace(/%[a-z%]/g, function(match) {
      if ('%%' === match)
        return;
      index++;
      if ('%c' === match) {
        lastC = index;
      }
    });
    args.splice(lastC, 0, c);
    return args;
  }
  function log() {
    return 'object' === typeof console && console.log && Function.prototype.apply.call(console.log, console, arguments);
  }
  function save(namespaces) {
    try {
      if (null == namespaces) {
        storage.removeItem('debug');
      } else {
        storage.debug = namespaces;
      }
    } catch (e) {}
  }
  function load() {
    var r;
    try {
      r = storage.debug;
    } catch (e) {}
    return r;
  }
  exports.enable(load());
  global.define = __define;
  return module.exports;
});



System.register("npm:debug@2.1.1", ["npm:debug@2.1.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:debug@2.1.1/browser");
  global.define = __define;
  return module.exports;
});



System.register("npm:jsonp@0.1.0/index", ["npm:debug@2.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var debug = require("npm:debug@2.1.1")('jsonp');
  module.exports = jsonp;
  var count = 0;
  function noop() {}
  function jsonp(url, opts, fn) {
    if ('function' == typeof opts) {
      fn = opts;
      opts = {};
    }
    if (!opts)
      opts = {};
    var prefix = opts.prefix || '__jp';
    var param = opts.param || 'callback';
    var timeout = null != opts.timeout ? opts.timeout : 60000;
    var enc = encodeURIComponent;
    var target = document.getElementsByTagName('script')[0] || document.head;
    var script;
    var timer;
    var id = prefix + (count++);
    if (timeout) {
      timer = setTimeout(function() {
        cleanup();
        if (fn)
          fn(new Error('Timeout'));
      }, timeout);
    }
    function cleanup() {
      if (script.parentNode)
        script.parentNode.removeChild(script);
      window[id] = noop;
      if (timer)
        clearTimeout(timer);
    }
    function cancel() {
      if (window[id]) {
        cleanup();
      }
    }
    window[id] = function(data) {
      debug('jsonp got', data);
      cleanup();
      if (fn)
        fn(null, data);
    };
    url += (~url.indexOf('?') ? '&' : '?') + param + '=' + enc(id);
    url = url.replace('?&', '?');
    debug('jsonp req "%s"', url);
    script = document.createElement('script');
    script.src = url;
    target.parentNode.insertBefore(script, target);
    return cancel;
  }
  global.define = __define;
  return module.exports;
});



System.register("npm:jsonp@0.1.0", ["npm:jsonp@0.1.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:jsonp@0.1.0/index");
  global.define = __define;
  return module.exports;
});



System.register("lib/search-trends-api", ["npm:jsonp@0.1.0"], function($__export) {
  "use strict";
  var __moduleName = "lib/search-trends-api";
  var jsonp,
      SearchTrendsApi;
  return {
    setters: [function(m) {
      jsonp = m.default;
    }],
    execute: function() {
      SearchTrendsApi = (function() {
        var SearchTrendsApi = function SearchTrendsApi() {
          this.googleURL = "https://morning-river-6203.herokuapp.com/google_trends";
        };
        return ($traceurRuntime.createClass)(SearchTrendsApi, {load: function() {
            var $__0 = this;
            return new Promise((function(resolve, reject) {
              jsonp($__0.googleURL, {param: 'callback'}, (function(err, data) {
                err ? reject(err) : resolve(data);
              }));
            }));
          }}, {});
      }());
      $__export('default', new SearchTrendsApi());
    }
  };
});



System.register("lib/main", ["lib/search-trends-api", "lib/trends-item", "lib/trends-view"], function($__export) {
  "use strict";
  var __moduleName = "lib/main";
  var SearchTrendsApi,
      TrendsItem,
      TrendsView;
  return {
    setters: [function(m) {
      SearchTrendsApi = m.default;
    }, function(m) {
      TrendsItem = m.default;
    }, function(m) {
      TrendsView = m.default;
    }],
    execute: function() {
      SearchTrendsApi.load().then(TrendsItem, function(err) {
        console.log("TrendsItem Error: ", err);
      }).then(TrendsView, function(err) {
        console.log("TrendsView Error: ", err);
      });
      $__export('default', {});
    }
  };
});




});
//# sourceMappingURL=build.js.map