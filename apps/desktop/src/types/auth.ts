export interface ApiUser {
  id: string;
  email: string;
  username: string;
  image?: string | null;
  emailVerified?: boolean;
}

export interface User {
  id: string;
  email: string;
  username: string;
  image?: string | null;
}

export interface LoginInput {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
}
