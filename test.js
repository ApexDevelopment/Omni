const omni = require("./src/index.js");

test("Omni exports properly", () => {
	expect(omni).toBeDefined();
	expect(omni.start).toBeDefined();
	expect(omni.stop).toBeDefined();
	expect(omni.on).toBeDefined();
	expect(omni.off).toBeDefined();
	expect(omni.create_channel).toBeDefined();
	expect(omni.create_user).toBeDefined();
	expect(omni.delete_channel).toBeDefined();
	expect(omni.delete_message).toBeDefined();
	expect(omni.delete_user).toBeDefined();
	expect(omni.get_all_channels).toBeDefined();
	expect(omni.get_all_online_local_users).toBeDefined();
	expect(omni.get_all_online_remote_users).toBeDefined();
	expect(omni.get_all_online_users).toBeDefined();
	expect(omni.get_channel).toBeDefined();
	expect(omni.get_messages).toBeDefined();
	expect(omni.get_online_local_users).toBeDefined();
	expect(omni.get_online_remote_users).toBeDefined();
	expect(omni.get_online_users).toBeDefined();
	expect(omni.get_online_users).toBeDefined();
	expect(omni.get_user).toBeDefined();
	expect(omni.login_user).toBeDefined();
	expect(omni.logout_user).toBeDefined();
	expect(omni.send_message).toBeDefined();
	expect(omni.send_pair_request).toBeDefined();
});

test("Omni starts without exceptions", () => {
	omni.start("defaultconf.json");
});

let user_id = null;
test("Omni successfully creates a user", async () => {
	user_id = await omni.create_user("test");
	expect(typeof(user_id)).toBe("string");
});

test("Omni prevents duplicate usernames", async () => {
	expect(await omni.create_user("test")).toBe(null);
});

test("Omni successfully creates a channel", async () => {
	expect(typeof(await omni.create_channel("test"))).toBe("string");
});

test("Omni prevents duplicate channel names", async () => {
	expect(await omni.create_channel("test")).toBe(null);
});

test("Omni successfully logs in a user", async () => {
	expect(await omni.login_user(user_id)).toBe(true);
});

test("Omni successfully stops", () => {
	omni.stop();
});