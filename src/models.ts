interface WithId {
	id: number;
}

interface WithActor {
	actor: number;
}

interface PineResourceBase extends WithId {
	created_at: Date;
}

export interface User extends PineResourceBase, WithActor {
	username: string;
	password: string | null;
	jwt_secret: string | null;
	email: string | null;
}
