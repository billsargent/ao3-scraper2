login = ENV.fetch("OTW_ARCHIVIST_LOGIN", "offline_importer")
email = ENV.fetch("OTW_ARCHIVIST_EMAIL", "offline-importer@example.invalid")
password = ENV.fetch("OTW_ARCHIVIST_PASSWORD")

user = User.find_or_initialize_by(login: login)
user.assign_attributes(
  email: email,
  confirmed_at: Time.current,
  age_over_13: "1",
  data_processing: "1",
  terms_of_service: "1"
)
user.password = password
user.password_confirmation = password
user.save!
role = Role.find_or_create_by!(name: "archivist")
user.roles << role unless user.roles.include?(role)
puts({ login: user.login, id: user.id, archivist: user.is_archivist? }.to_json)
