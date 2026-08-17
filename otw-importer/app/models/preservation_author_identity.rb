class PreservationAuthorIdentity < ApplicationRecord
  belongs_to :preservation_source
  has_many :preservation_work_authors, dependent: :destroy
  has_many :preservation_work_links, through: :preservation_work_authors

  validates :source_author_id, presence: true, uniqueness: { scope: :preservation_source_id }
  validates :display_name, presence: true
end
