export interface ApiUser {
  id: string;
  email: string;
  username: string;
}

export interface User {
  id: string;
  email: string;
  username: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
}
