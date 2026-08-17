class PreservationSource < ApplicationRecord
  has_many :preservation_author_identities, dependent: :restrict_with_exception
  has_many :preservation_work_links, dependent: :restrict_with_exception
  has_many :preservation_series_links, dependent: :restrict_with_exception

  validates :key, presence: true, uniqueness: true
  validates :origin, presence: true
end
