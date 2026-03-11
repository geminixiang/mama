export interface ChatMessage {
	id: string;
	sessionKey: string;
	userId: string;
	userName?: string;
	text: string;
	attachments?: { name: string; localPath: string }[];
}

export interface ChatResponseContext {
	respond(text: string): Promise<void>;
	replaceResponse(text: string): Promise<void>;
	respondInThread(text: string): Promise<void>;
	setWorking(working: boolean): Promise<void>;
	uploadFile(filePath: string, title?: string): Promise<void>;
	deleteResponse(): Promise<void>;
}

export interface PlatformInfo {
	name: string;
	formattingGuide: string;
	channels: { id: string; name: string }[];
	users: { id: string; userName: string; displayName: string }[];
}

export interface ChatAdapter {
	start(): Promise<void>;
	stop(): Promise<void>;
	getPlatformInfo(): PlatformInfo;
}
