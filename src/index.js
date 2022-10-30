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
	constructor(name, id, admin_only = false, is_private = false) {
		this.id = id;
		this.name = name;
		this.admin_only = admin_only;
		this.is_private = is_private;
		this.local = true;
	}
}

class User {
	constructor(id, username, admin = false) {
		this.id = id;
		this.username = username;
		this.admin = admin;
		this.local = true;
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

function on(event, callback) {
	if (!event_handlers[event]) {
		event_handlers[event] = [];
	}

	let handler = new EventHandler(event, callback);
	event_handlers[event].push(handler);
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

function create_user(username, admin = false) {
	if (find_user_by_username(username)) {
		return;
	}

	const id = uuidv4();
	user_database[id] = new User(id, username, admin);
	return id;
}

function delete_user(id) {
	if (!user_database[id]) {
		return;
	}

	if (online_users[id]) {
		logout_user(id);
	}

	delete user_database[id];
}

function get_user(id) {
	if (!user_database[id]) {
		return;
	}
	
	return user_database[id];
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

function get_all_online_users() {
	return Object.keys(online_users);
}

function get_all_online_local_users() {
	return Object.keys(online_users).filter((user_id) => {
		return user_database[user_id].local;
	});
}

function get_all_online_remote_users() {
	return Object.keys(online_users).filter((user_id) => {
		return !user_database[user_id].local;
	});
}

function get_online_users(channel_id) {
	if (!channels[channel_id]) {
		return;
	}

	return Object.keys(online_users).filter((user_id) => {
		return channels[channel_id].admin_only ? user_database[user_id].admin : true;
	});
}

function get_online_local_users(channel_id) {
	if (!channels[channel_id]) {
		return;
	}

	return Object.keys(online_users).filter((user_id) => {
		return user_database[user_id].local && (channels[channel_id].admin_only ? user_database[user_id].admin : true);
	});
}

function get_online_remote_users(channel_id) {
	if (!channels[channel_id]) {
		return;
	}

	return Object.keys(online_users).filter((user_id) => {
		return !user_database[user_id].local && (channels[channel_id].admin_only ? user_database[user_id].admin : true);
	});
}

function create_channel(name) {
	let channel = new Channel(name, uuidv4());
	channels[channel.id] = channel;
	message_database[channel.id] = [];
	emit("channel_create", channel);
	return channel.id;
}

function delete_channel(id) {
	if (!channels[id]) {
		return;
	}

	delete channels[id];
	delete message_database[id];
	emit("channel_delete", id);
}

function get_all_channels() {
	return Object.keys(channels);
}

function get_channel(id) {
	return channels[id];
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

function delete_message(id) {
	for (let channel_id in message_database) {
		// TODO: This is inefficient
		message_database[channel_id] = message_database[channel_id].filter((message) => {
			return message.id != id;
		});
	}
}

module.exports = {
	on, off,
	send_message, delete_message,
	create_channel, delete_channel,
	create_user, get_user, delete_user,
	login_user, logout_user,
	get_all_channels, get_channel,
	get_all_online_users, get_all_online_local_users, get_all_online_remote_users,
	get_online_users, get_online_local_users, get_online_remote_users
};