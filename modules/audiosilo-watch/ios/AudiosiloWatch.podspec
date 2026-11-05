Pod::Spec.new do |s|
  s.name           = 'AudiosiloWatch'
  s.version        = '1.0.0'
  s.summary        = 'The phone side of the AudioSilo Apple Watch link'
  s.description    = 'The single WCSessionDelegate on the iPhone: pair and book messages to the watch, its watch-state back.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
