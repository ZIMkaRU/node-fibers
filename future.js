"use strict";
require('./fibers');
var util = require('util');
module.exports = Future;
Function.prototype.future = function() {
	var fn = this;
	return function() {
		return new FiberFuture(fn, this, arguments);
	};
};

function Future() {}

/**
 * Wrap a node-style async function to return a future in place of using a callback.
 */
Future.wrap = function(fn, idx) {
	idx = idx === undefined ? fn.length - 1 : idx;
	return function() {
		var args = Array.prototype.slice.call(arguments);
		if (args.length > idx) {
			throw new Error('function expects no more than '+ idx+ ' arguments');
		}
		var future = new Future;
		args[idx] = future.resolver();
		fn.apply(this, args);
		return future;
	};
};

/**
 * Wait on a series of futures and then return. If the futures throw an exception this function
 * /won't/ throw it back. You can get the value of the future by calling get() on it directly. If
 * you want to wait on a single future you're better off calling future.wait() on the instance.
 */
Future.wait = function wait(/* ... */) {

	// Normalize arguments + pull out a FiberFuture for reuse if possible
	var futures = Array.prototype.slice.call(arguments, 0), singleFiberFuture;
	for (var ii = 0; ii < futures.length; ++ii) {
		if (futures[ii] instanceof Future) {
			// Ignore already resolved fibers
			if (futures[ii].isResolved()) {
				futures.splice(ii, 1);
				--ii;
				continue;
			}
			// Look for fiber reuse
			if (!singleFiberFuture && futures[ii] instanceof FiberFuture && !futures[ii].started) {
				singleFiberFuture = futures[ii];
				futures.splice(ii, 1);
				--ii;
				continue;
			}
		} else if (futures[ii] instanceof Array) {
			// Flatten arrays
			futures.splice.apply(futures, [ii, 1].concat(futures[ii]));
			--ii;
			continue;
		} else {
			throw new Error(futures[ii] + ' is not a future');
		}
	}

	// Resumes current fiber
	var fiber = Fiber.current;
	if (!fiber) {
		throw new Error('Can\'t wait without a fiber');
	}

	// Resolve all futures
	var pending = futures.length + (singleFiberFuture ? 1 : 0);
	function cb() {
		if (!--pending) {
			fiber.run();
		}
	}
	for (var ii = 0; ii < futures.length; ++ii) {
		futures[ii].resolve(cb);
	}

	// Reusing a fiber?
	if (singleFiberFuture) {
		singleFiberFuture.started = true;
		try {
			singleFiberFuture.return(
				singleFiberFuture.fn.apply(singleFiberFuture.context, singleFiberFuture.args));
		} catch(e) {
			singleFiberFuture.throw(e);
		}
		--pending;
	}

	// Yield this fiber
	if (pending) {
		Fiber.yield();
	}
};

Future.prototype = {
	/**
	 * Return the value of this future. If the future hasn't resolved yet this will throw an error.
	 */
	get: function() {
		if (!this.resolved) {
			throw new Error('Future must resolve before value is ready');
		} else if (this.error) {
			throw this.error;
		} else {
			return this.value;
		}
	},

	/**
	 * Mark this future as returned. All pending callbacks will be invoked immediately.
	 */
	"return": function(value) {
		if (this.resolved) {
			throw new Error('Future resolved more than once');
		}
		this.value = value;
		this.resolved = true;

		var callbacks = this.callbacks;
		if (callbacks) {
			delete this.callbacks;
			for (var ii = 0; ii < callbacks.length; ++ii) {
				try {
					callbacks[ii](undefined, value);
				} catch(ex) {
					console.log(ex.stack || ex);
					process.exit(1);
				}
			}
		}
	},

	/**
	 * Throw from this future as returned. All pending callbacks will be invoked immediately.
	 */
	"throw": function(error) {
		if (this.resolved) {
			throw new Error('Future resolved more than once');
		} else if (!error) {
			throw new Error('Must throw non-empty error');
		}
		this.error = error;
		this.resolved = true;

		var callbacks = this.callbacks;
		if (callbacks) {
			delete this.callbacks;
			for (var ii = 0; ii < callbacks.length; ++ii) {
				try {
					callbacks[ii](error);
				} catch(ex) {
					console.log(ex.stack || ex);
					process.exit(1);
				}
			}
		}
	},

	/**
	 * Returns whether or not this future has resolved yet.
	 */
	isResolved: function() {
		return this.resolved === true;
	},

	/**
	 * Returns a node-style function which will mark this future as resolved when called.
	 */
	resolver: function() {
		return function(err, val) {
			if (err) {
				this.throw(err);
			} else {
				this.return(val);
			}
		}.bind(this);
	},

	/**
	 * Waits for this future to resolve and then invokes a callback.
	 */
	resolve: function(cb) {
		if (this.resolved) {
			cb(this.error, this.value);
		} else {
			(this.callbacks = this.callbacks || []).push(cb);
		}
		return this;
	},

	/**
	 * Resolve only in the case of success
	 */
	resolveSuccess: function(cb) {
		this.resolve(function(err, val) {
			if (err) {
				return;
			}
			cb(val);
		});
		return this;
	},

	/**
	 * Propogate results to another future.
	 */
	proxy: function(future) {
		this.resolve(function(err, val) {
			if (err) {
				future.throw(err);
			} else {
				future.return(val);
			}
		});
	},

	/**
	 * Propogate only errors to an another future or array of futures.
	 */
	proxyErrors: function(futures) {
		this.resolve(function(err) {
			if (!err) {
				return;
			}
			if (futures instanceof Array) {
				for (var ii = 0; ii < futures.length; ++ii) {
					futures[ii].throw(err);
				}
			} else {
				futures.throw(err);
			}
		});
		return this;
	},

	/**
	 * Differs from its functional counterpart in that it actually resolves the future. Thus if the
	 * future threw, future.wait() will throw.
	 */
	wait: function() {
		Future.wait(this);
		return this.get();
	},
};

/**
 * A function call which loads inside a fiber automatically and returns a future.
 */
function FiberFuture(fn, context, args) {
	this.fn = fn;
	this.context = context;
	this.args = args;
	this.started = false;
	var that = this;
	process.nextTick(function() {
		if (!that.started) {
			that.started = true;
			Fiber(function() {
				try {
					that.return(fn.apply(context, args));
				} catch(e) {
					that.throw(e);
				}
			}).run();
		}
	});
}
util.inherits(FiberFuture, Future);
