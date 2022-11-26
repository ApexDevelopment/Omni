const Omni = require("./src/index.js");

test("Omni exports properly", () => {
	expect(Omni).toBeDefined();
	expect(Omni.start).toBeDefined();
	expect(Omni.on).toBeDefined();
	expect(Omni.off).toBeDefined();
	expect(Omni.create_channel).toBeDefined();
	expect(Omni.create_user).toBeDefined();
	expect(Omni.delete_channel).toBeDefined();
	expect(Omni.delete_message).toBeDefined();
	expect(Omni.delete_user).toBeDefined();
	expect(Omni.get_all_channels).toBeDefined();
	expect(Omni.get_all_online_local_users).toBeDefined();
	expect(Omni.get_all_online_remote_users).toBeDefined();
	expect(Omni.get_all_online_users).toBeDefined();
	expect(Omni.get_channel).toBeDefined();
	expect(Omni.get_messages).toBeDefined();
	expect(Omni.get_online_local_users).toBeDefined();
	expect(Omni.get_online_remote_users).toBeDefined();
	expect(Omni.get_online_users).toBeDefined();
	expect(Omni.get_online_users).toBeDefined();
	expect(Omni.get_user).toBeDefined();
	expect(Omni.login_user).toBeDefined();
	expect(Omni.logout_user).toBeDefined();
	expect(Omni.send_message).toBeDefined();
});