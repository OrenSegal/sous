import { User } from '../Domain/User';

export function renderScreen(user: User) {
  return user.id;
}
