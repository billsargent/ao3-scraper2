module PreservationImport
  module WorkIndexExtension
    def indexed_creators
      identities = preservation_work_link&.preservation_author_identities
      return super if identities.blank?
      return ["Anonymous"] if identities.all?(&:anonymous?)

      identities.map(&:display_name)
    end
  end
end
