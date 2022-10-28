const { v4: uuidv4 } = require("uuid");

// In the future this should be an actual database
let message_database = {};
let user_database = {};
let online_users = {};
let channels = {};
let event_handlers = {};

class EventHandler {
	constructor(event, callback) {
		this.event = event;
		this.callback = callback;
	}

	fire(data) {
		this.callback(data);
	}
}

class Channel {
	constructor(name, id) {
		this.id = id;
		this.name = name;
	}
}

class User {
	constructor(id, username) {
		this.id = id;
		this.username = username;
	}
}

class Message {
	constructor(id, channel_id, user_id, content) {
		this.id = id;
		this.channel_id = channel_id;
		this.user_id = user_id;
		this.content = content;
	}
}

function find_user_by_username(username) {
	for (let user_id in user_database) {
		if (user_database[user_id].username == username) {
			return user_database[user_id];
		}
	}

	return null;
}

function on(event, handler) {
	if (!event_handlers[event]) {
		event_handlers[event] = [];
	}

	event_handlers[event].push(new EventHandler(event, handler));
	return handler;
}

function off(event, handler) {
	if (!event_handlers[event]) {
		return;
	}
	
	event_handlers[event] = event_handlers[event].filter((event_handler) => {
		return event_handler !== handler;
	});
}

function emit(event, data) {
	if (!event_handlers[event]) {
		return;
	}

	event_handlers[event].forEach((event_handler) => {
		event_handler.fire(data);
	});
}

function send_message(user_id, channel_id, content) {
	if (!channels[channel_id]) {
		return;
	}

	if (!message_database[channel_id]) {
		return;
	}

	if (!user_database[user_id] || !online_users[user_id]) {
		return;
	}

	let message = new Message(uuidv4(), channel_id, user_id, content);
	message_database[channel_id].push(message);
	emit("message", message);
	return message.id;
}

function create_channel(name) {
	let channel = new Channel(name, uuidv4());
	channels[channel.id] = channel;
	message_database[channel.id] = [];
	emit("channel_create", channel);
	return channel.id;
}

function create_user(username) {
	if (find_user_by_username(username)) {
		return;
	}

	const id = uuidv4();
	user_database[id] = new User(id, username);
	return id;
}

function login_user(id) {
	if (!user_database[id]) {
		return;
	}

	online_users[id] = true;
	emit("user_online", user_database[id]);
}

function logout_user(id) {
	if (!user_database[id]) {
		return;
	}

	delete online_users[id];
	emit("user_offline", user_database[id]);
}

module.exports = { on, off, send_message, create_channel, create_user, login_user };