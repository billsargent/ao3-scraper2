class PreservationChapterLink < ApplicationRecord
  belongs_to :preservation_work_link
  belongs_to :chapter

  validates :source_chapter_id, presence: true, uniqueness: { scope: :preservation_work_link_id }
  validates :imported_hash, presence: true
end
