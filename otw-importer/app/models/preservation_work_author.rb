class PreservationWorkAuthor < ApplicationRecord
  belongs_to :preservation_work_link
  belongs_to :preservation_author_identity

  validates :position, numericality: { only_integer: true, greater_than: 0 }
end
