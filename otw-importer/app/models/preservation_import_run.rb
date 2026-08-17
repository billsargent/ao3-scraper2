class PreservationImportRun < ApplicationRecord
  validates :package_id, presence: true, uniqueness: true
  validates :package_path, :status, presence: true
end
