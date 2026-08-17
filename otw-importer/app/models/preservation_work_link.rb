class PreservationWorkLink < ApplicationRecord
  belongs_to :preservation_source
  belongs_to :work
  has_many :preservation_work_authors, -> { order(:position) }, dependent: :destroy
  has_many :preservation_author_identities, through: :preservation_work_authors
  has_many :preservation_chapter_links, dependent: :destroy

  validates :source_work_id, presence: true, uniqueness: { scope: :preservation_source_id }
  validates :source_url, :imported_hash, :last_imported_at, presence: true
end
