class EventHandler {
	constructor(event, callback) {
		this.event = event;
		this.callback = callback;
		this.fire = this.fire.bind(this);
	}

	fire(data) {
		this.callback(data);
	}
}

class EventBus {
	constructor() {
		this.event_handlers = {};
		this.on = this.on.bind(this);
		this.off = this.off.bind(this);
		this.emit = this.emit.bind(this);
	}

	on(event, callback) {
		console.log(this, this.event_handlers, event, callback);
		if (!this.event_handlers[event]) {
			this.event_handlers[event] = [];
		}
	
		let handler = new EventHandler(event, callback);
		this.event_handlers[event].push(handler);
		return handler;
	}
	
	off(event, handler) {
		if (!this.event_handlers[event]) {
			return;
		}
		
		this.event_handlers[event] = this.event_handlers[event].filter((event_handler) => {
			return event_handler !== handler;
		});
	}
	
	emit(event, data) {
		if (!this.event_handlers[event]) {
			return;
		}
	
		this.event_handlers[event].forEach((event_handler) => {
			event_handler.fire(data);
		});
	}
}

module.exports = { EventBus, EventHandler };