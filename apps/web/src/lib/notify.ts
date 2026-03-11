import { notifications } from '@mantine/notifications';

export function notifyError(title: string, message: string) {
  notifications.show({
    color: 'red',
    title,
    message,
  });
}

export function notifySuccess(title: string, message: string) {
  notifications.show({
    color: 'teal',
    title,
    message,
  });
}

