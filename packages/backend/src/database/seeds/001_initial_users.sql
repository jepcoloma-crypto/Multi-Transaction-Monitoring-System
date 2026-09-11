INSERT INTO users (email, username, password_hash, first_name, last_name) VALUES
  ('admin@example.com', 'admin', '$2a$12$2IVewIdrNPacsvksKTTKgeOu4R0w1bjU4CZU44WwympWLaZVXqpfa', 'System', 'Administrator'),
  ('operator@test.com', 'operator', '$2a$12$2IVewIdrNPacsvksKTTKgeOu4R0w1bjU4CZU44WwympWLaZVXqpfa', 'Test', 'Operator');

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = 'admin@example.com' AND r.name = 'administrator';

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = 'operator@test.com' AND r.name = 'operator';
